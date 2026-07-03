/**
 * Test harness — boots real servers on ephemeral ports against temp data
 * repos (git: true, remote-less, KANON_GIT_REMOTE_SYNC=0). No network
 * beyond localhost.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventActor } from "@kanon/core";
import { initDataRepo } from "@kanon/store";
import { loadConfig } from "./config";
import { type RunningServer, startServer } from "./index";

export const TEST_ACTOR: EventActor = { type: "human", id: "carlos@example.com", surface: "cli" };

/** `test-key` carries a session prefix; `agent-key` is an agent principal. */
export const DEFAULT_KEYS = "test-key:carlos@example.com:human:sess,agent-key:claude-agent:agent";

const dirs: string[] = [];
const servers: RunningServer[] = [];

export function tempDir(prefix = "kanon-server-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export interface BootOptions {
  dataDir?: string;
  workspace?: string;
  apiKeys?: string;
  webhookIntervalMs?: string;
  sessionStaleMs?: string;
  sessionJanitorIntervalMs?: string;
}

export interface TestServer {
  dataDir: string;
  server: RunningServer;
  url: string;
}

export function boot(options: BootOptions = {}): TestServer {
  const dataDir = options.dataDir ?? tempDir();
  if (!existsSync(join(dataDir, "meta.json"))) {
    initDataRepo({
      dir: dataDir,
      workspace: options.workspace ?? "test",
      actor: TEST_ACTOR,
      git: true,
    });
  }
  const config = loadConfig({
    KANON_DATA_DIR: dataDir,
    KANON_API_KEYS: options.apiKeys ?? DEFAULT_KEYS,
    KANON_GIT_REMOTE_SYNC: "0",
    KANON_WEBHOOK_INTERVAL_MS: options.webhookIntervalMs ?? "25",
    // Janitor off by default in tests — enable per-test via options.
    KANON_SESSION_STALE_MS: options.sessionStaleMs ?? "0",
    KANON_SESSION_JANITOR_INTERVAL_MS: options.sessionJanitorIntervalMs ?? "60000",
    PORT: "0",
  });
  const server = startServer(config);
  servers.push(server);
  return { dataDir, server, url: server.url };
}

/** Stop every server and remove every temp dir booted since the last call. */
export function cleanup(): void {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

export function headers(key = "test-key"): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export async function api(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  key = "test-key",
): Promise<ApiResult> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: headers(key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Assert 2xx and return the body. */
export async function ok(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  key = "test-key",
): Promise<Record<string, unknown>> {
  const result = await api(url, method, path, body, key);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${method} ${path} → ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

/** Poll until `probe` returns a value, or fail after `timeoutMs`. */
export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}
