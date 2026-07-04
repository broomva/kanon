#!/usr/bin/env bun

/**
 * @kanon/server — the rendezvous server. Hono on Bun.serve.
 *
 * One server per workspace data repo (KANON_DATA_DIR is a git clone the
 * server OWNS). REST v1 + durable event feed + SSE + webhooks + display-id
 * allocation. See README.md for the API table and deployment notes.
 */

import { KanonService } from "@kanon/service";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "./app";
import { loadConfig, type ServerConfig } from "./config";
import { WebhookDeliverer } from "./webhooks";

export { KanonService, ServiceError } from "@kanon/service";
export { createApp } from "./app";
export { ConfigError, loadConfig, parseApiKeys, type ServerConfig } from "./config";
export { WebhookDeliverer } from "./webhooks";

export interface RunningServer {
  port: number;
  url: string;
  service: KanonService;
  app: Hono<AppEnv>;
  deliverer: WebhookDeliverer;
  stop(): void;
}

export function startServer(config: ServerConfig): RunningServer {
  const service = new KanonService({
    dataDir: config.dataDir,
    gitRemoteSync: config.gitRemoteSync,
    allowPrivateWebhooks: config.allowPrivateWebhooks,
  });
  const app = createApp(service, config);

  const deliverer = new WebhookDeliverer(service, { intervalMs: config.webhookIntervalMs });
  deliverer.start();

  // Startup sync + periodic pull --rebase → refresh → broadcast.
  service.syncWithRemote();
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  if (config.gitRemoteSync) {
    syncTimer = setInterval(() => {
      try {
        service.syncWithRemote();
      } catch (error) {
        console.warn(
          `kanon-server: periodic sync failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, config.syncIntervalMs);
    if (typeof syncTimer === "object" && "unref" in syncTimer) {
      syncTimer.unref();
    }
  }

  // Stale-session janitor: live sessions with no movement past the threshold
  // get marked `stale`. The server (the daemon that owns the clone) is the
  // ONE janitor — per-agent stdio MCPs deliberately don't run it, so
  // concurrent processes never race to stale the same session.
  const JANITOR_ACTOR = { type: "system", id: "kanon-janitor", surface: "system" } as const;
  let janitorTimer: ReturnType<typeof setInterval> | undefined;
  if (config.sessionStaleMs > 0) {
    janitorTimer = setInterval(() => {
      try {
        const { staled } = service.markStaleSessions(JANITOR_ACTOR, config.sessionStaleMs);
        if (staled.length > 0) {
          console.warn(`kanon-server: janitor staled ${staled.length} agent session(s)`);
        }
      } catch (error) {
        console.warn(
          `kanon-server: session janitor failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, config.sessionJanitorIntervalMs);
    if (typeof janitorTimer === "object" && "unref" in janitorTimer) {
      janitorTimer.unref();
    }
  }

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    // SSE connections are long-lived; never idle-close them.
    idleTimeout: 0,
  });

  return {
    port: server.port ?? config.port,
    url: `http://localhost:${server.port ?? config.port}`,
    service,
    app,
    deliverer,
    stop(): void {
      if (syncTimer !== undefined) clearInterval(syncTimer);
      if (janitorTimer !== undefined) clearInterval(janitorTimer);
      deliverer.stop();
      server.stop(true);
      service.close();
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const running = startServer(config);
  console.log(
    `kanon-server: workspace "${running.service.workspace}" on ${running.url} ` +
      `(${running.service.eventCount()} events, head ${running.service.head() ?? "∅"}, ` +
      `remote sync ${config.gitRemoteSync ? "on" : "off"})`,
  );
}
