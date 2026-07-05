/**
 * Server configuration — all from env, validated at boot (a misconfigured
 * server must refuse to start, not 500 at the first request).
 *
 *   KANON_DATA_DIR         path to a git clone of ONE workspace data repo.
 *                          The server OWNS this clone: it appends, commits,
 *                          pushes, and pulls it. The workspace is derived
 *                          from the clone's meta.json — requests never
 *                          choose a workspace (single-workspace server per
 *                          deployment = the tenancy model).
 *   KANON_API_KEYS         comma-separated `key:actorId:actorType[:sessionPrefix]`
 *                          entries. The bearer token maps to the actor every
 *                          event written through this server is attributed to.
 *   KANON_GIT_REMOTE_SYNC  default "1" — after each ingest/write commit, push;
 *                          on startup and every KANON_SYNC_INTERVAL seconds,
 *                          pull --rebase + refresh the projection. "0" for a
 *                          remote-less clone (tests, air-gapped).
 *   KANON_SYNC_INTERVAL    seconds between pull --rebase cycles (default 30).
 *   KANON_RELOAD_INTERVAL  seconds between plain disk-reload cycles (no git
 *                          pull), for a shadow mirror (KANON_GIT_REMOTE_SYNC=0)
 *                          fed by an out-of-band importer: the server re-reads
 *                          the segments so the served view + SSE subscribers
 *                          pick up appended events without a restart. Default
 *                          0 = off. Ignored when KANON_GIT_REMOTE_SYNC is on
 *                          (the sync loop already reloads after each pull).
 *   KANON_WEBHOOK_INTERVAL_MS  webhook delivery-loop tick (default 500).
 *   KANON_SESSION_STALE_MS agent sessions still pending/active/awaitingInput
 *                          with no movement for this long are marked `stale`
 *                          by the janitor (default 1800000 = 30 min; 0
 *                          disables the janitor).
 *   KANON_SESSION_JANITOR_INTERVAL_MS  janitor tick (default 60000).
 *   PORT                   listen port (default 3000; 0 = ephemeral).
 */

import { ACTOR_TYPES, type ActorType } from "@kanon/core";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ApiKeyPrincipal {
  actorId: string;
  actorType: ActorType;
  /** When set, events carry `sessionId: "<prefix>-<boot ulid>"`. */
  sessionPrefix?: string;
}

export interface ServerConfig {
  dataDir: string;
  /** bearer token → principal. */
  apiKeys: Map<string, ApiKeyPrincipal>;
  gitRemoteSync: boolean;
  /** Allow webhook targets on private/loopback ranges (SSRF guard off). */
  allowPrivateWebhooks: boolean;
  syncIntervalMs: number;
  /** Plain disk-reload cadence for a shadow mirror; 0 = off. */
  reloadIntervalMs: number;
  webhookIntervalMs: number;
  /** Inactivity threshold before the janitor stales a live session; 0 = off. */
  sessionStaleMs: number;
  sessionJanitorIntervalMs: number;
  port: number;
}

/** Parse `key:actorId:actorType[:sessionPrefix]`, comma-separated. */
export function parseApiKeys(raw: string): Map<string, ApiKeyPrincipal> {
  const keys = new Map<string, ApiKeyPrincipal>();
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const parts = entry.split(":");
    const [token, actorId, actorType, sessionPrefix] = parts;
    if (
      parts.length < 3 ||
      parts.length > 4 ||
      token === undefined ||
      token.length === 0 ||
      actorId === undefined ||
      actorId.length === 0 ||
      actorType === undefined
    ) {
      throw new ConfigError(
        "KANON_API_KEYS entries must be `key:actorId:actorType[:sessionPrefix]` " +
          `— got "${entry}"`,
      );
    }
    if (!ACTOR_TYPES.includes(actorType as ActorType)) {
      throw new ConfigError(
        `KANON_API_KEYS actorType must be one of ${ACTOR_TYPES.join("|")} — got "${actorType}"`,
      );
    }
    if (keys.has(token)) {
      throw new ConfigError("KANON_API_KEYS contains a duplicate key");
    }
    keys.set(token, {
      actorId,
      actorType: actorType as ActorType,
      ...(sessionPrefix !== undefined && sessionPrefix.length > 0 ? { sessionPrefix } : {}),
    });
  }
  if (keys.size === 0) {
    throw new ConfigError("KANON_API_KEYS must contain at least one key");
  }
  return keys;
}

function intEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const dataDir = env.KANON_DATA_DIR;
  if (dataDir === undefined || dataDir.length === 0) {
    throw new ConfigError("KANON_DATA_DIR is required (path to a workspace data-repo clone)");
  }
  const rawKeys = env.KANON_API_KEYS;
  if (rawKeys === undefined || rawKeys.length === 0) {
    throw new ConfigError(
      "KANON_API_KEYS is required (comma-separated key:actorId:actorType[:sessionPrefix])",
    );
  }
  return {
    dataDir,
    apiKeys: parseApiKeys(rawKeys),
    gitRemoteSync: (env.KANON_GIT_REMOTE_SYNC ?? "1") !== "0",
    allowPrivateWebhooks: (env.KANON_WEBHOOK_ALLOW_PRIVATE ?? "0") === "1",
    syncIntervalMs: intEnv(env, "KANON_SYNC_INTERVAL", 30, 1) * 1000,
    reloadIntervalMs: intEnv(env, "KANON_RELOAD_INTERVAL", 0, 0) * 1000,
    webhookIntervalMs: intEnv(env, "KANON_WEBHOOK_INTERVAL_MS", 500, 10),
    sessionStaleMs: intEnv(env, "KANON_SESSION_STALE_MS", 1_800_000, 0),
    sessionJanitorIntervalMs: intEnv(env, "KANON_SESSION_JANITOR_INTERVAL_MS", 60_000, 10),
    port: intEnv(env, "PORT", 3000, 0),
  };
}
