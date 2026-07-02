/** `kanon log [--limit N]` — the last N events of the canonical stream. */

import { loadLog } from "@kanon/store";
import { flagBool, flagInt, parseFlags } from "../args";
import { resolveRepoDir } from "../context";
import { emit } from "../output";

function summary(data: Record<string, unknown>): string {
  for (const field of ["title", "name", "body", "slug"]) {
    const value = data[field];
    if (typeof value === "string") {
      return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    }
  }
  return "";
}

export function logCommand(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { json: "boolean", repo: "value", limit: "value" },
    { min: 0, max: 0, usage: "kanon log [--limit N]" },
  );
  const dir = resolveRepoDir(flags);
  const limit = flagInt(flags, "limit", 1, 1_000_000) ?? 20;
  const report = loadLog(dir);
  if (report.conflicts.length > 0) {
    console.error(
      `warning: ${report.conflicts.length} conflicting duplicate event id(s) tie-broken`,
    );
  }
  const events = report.events.slice(-limit);
  emit(flagBool(flags, "json"), events, () => {
    if (events.length === 0) {
      console.log("empty log");
      return;
    }
    for (const event of events) {
      console.log(
        `${event.id}  ${event.ts}  ${event.actor.type}:${event.actor.id}  ` +
          `${event.op} ${event.model} ${summary(event.data)}`,
      );
    }
  });
}
