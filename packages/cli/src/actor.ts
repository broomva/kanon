/**
 * CLI actor identity — every event is attributed. Resolution order:
 *
 *   id:   KANON_ACTOR → git config user.email → user@host
 *   type: KANON_ACTOR_TYPE (default "human"; agents set "agent")
 *   sessionId: KANON_SESSION (optional)
 */

import { hostname, userInfo } from "node:os";
import { ACTOR_TYPES, type ActorType, type EventActor } from "@kanon/core";
import { CliError } from "./args";

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

export function resolveActor(): EventActor {
  const rawType = process.env.KANON_ACTOR_TYPE ?? "human";
  if (!ACTOR_TYPES.includes(rawType as ActorType)) {
    throw new CliError(`KANON_ACTOR_TYPE must be one of ${ACTOR_TYPES.join("|")} (got ${rawType})`);
  }
  const envId = process.env.KANON_ACTOR;
  const id =
    envId !== undefined && envId.length > 0
      ? envId
      : (gitEmail() ?? `${userInfo().username}@${hostname()}`);
  const sessionId = process.env.KANON_SESSION;
  return {
    type: rawType as ActorType,
    id,
    surface: "cli",
    ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
  };
}
