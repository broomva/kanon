/**
 * MCP server configuration — the Kanon MCP is a stdio process an agent
 * launches, so everything comes from the environment:
 *
 *   KANON_DATA_DIR   git clone of the workspace data repo the MCP writes to
 *                    (required). Reads hit the disposable SQLite projection;
 *                    writes append to the log + commit, exactly like the CLI.
 *   KANON_ACTOR      actor id every event written through this MCP is
 *                    attributed to (default: git email → user@host)
 *   KANON_ACTOR_TYPE human | agent | app | system (default "agent" — the MCP
 *                    is an agent surface)
 *   KANON_SESSION    optional session id stamped on every event
 *   KANON_GIT_REMOTE_SYNC  "1" pushes after each write + pulls periodically;
 *                    default "0" (a local agent working a local clone)
 */

import { hostname, userInfo } from "node:os";
import { ACTOR_TYPES, type ActorType, type EventActor } from "@kanon/core";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface McpConfig {
  dataDir: string;
  actor: EventActor;
  gitRemoteSync: boolean;
}

function gitEmail(): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", "config", "user.email"]);
    if (proc.exitCode !== 0) return undefined;
    const email = proc.stdout.toString().trim();
    return email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the writing actor: KANON_ACTOR → git email → user@host; surface "mcp". */
export function resolveActor(env: Record<string, string | undefined> = process.env): EventActor {
  const rawType = env.KANON_ACTOR_TYPE ?? "agent";
  if (!ACTOR_TYPES.includes(rawType as ActorType)) {
    throw new ConfigError(
      `KANON_ACTOR_TYPE must be one of ${ACTOR_TYPES.join("|")} (got ${rawType})`,
    );
  }
  const envId = env.KANON_ACTOR;
  const id =
    envId !== undefined && envId.length > 0
      ? envId
      : (gitEmail() ?? `${userInfo().username}@${hostname()}`);
  const sessionId = env.KANON_SESSION;
  return {
    type: rawType as ActorType,
    id,
    surface: "mcp",
    ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const dataDir = env.KANON_DATA_DIR;
  if (dataDir === undefined || dataDir.trim().length === 0) {
    throw new ConfigError("KANON_DATA_DIR is required (git clone of the workspace data repo)");
  }
  return {
    dataDir: dataDir.trim(),
    actor: resolveActor(env),
    gitRemoteSync: env.KANON_GIT_REMOTE_SYNC === "1",
  };
}
