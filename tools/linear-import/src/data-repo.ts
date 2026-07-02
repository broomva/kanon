/**
 * Minimal data-repo I/O for the importer — deliberately local to this package
 * (tools never import from @kanon/cli). The layout matches `kanon init`:
 *
 *   <repo>/meta.json            workspace slug + schema version + counters
 *   <repo>/events/YYYY-MM.jsonl monthly append-only segments
 *
 * loadEvents returns the log in ULID order (the log's total order), so
 * buildIdMap folds create → update → archive/unarchive chains chronologically:
 * the last `linearUpdatedAt` seen for a linearId wins as the idempotency
 * watermark, and the last archive/unarchive op wins as the archival state.
 *
 * Segments are a routing convention, not an ordering guarantee: the only
 * order is ULID. Imports append events with newer ULIDs into old-month files
 * (an issue updated in June lands in 2026-06.jsonl regardless of when the
 * import ran), so segment files are never immutable.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type KanonEvent, parseEventLine, segmentName, serializeEvent } from "@kanon/core";
import type { IdMap } from "./transform";

/** Read and parse every events/*.jsonl segment, sorted into ULID order. */
export function loadEvents(dir: string): KanonEvent[] {
  const eventsDir = join(dir, "events");
  let segments: string[] = [];
  try {
    segments = readdirSync(eventsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch {
    return []; // no events/ directory yet — empty log
  }
  const events: KanonEvent[] = [];
  for (const segment of segments) {
    const lines = readFileSync(join(eventsDir, segment), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    for (const line of lines) {
      events.push(parseEventLine(line));
    }
  }
  return events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Fold the log into linearId → {modelId, updatedAt, archived}. Any event whose
 * data carries a `linearId` claims the mapping (the first event to name a
 * linearId fixes its modelId). `linearUpdatedAt`, when present, advances the
 * idempotency watermark; events without it (archive ops, parent fixups) never
 * clobber an existing one. `archive`/`unarchive` ops fold into the archival
 * state — explicit ops are the ONLY archival mechanism (no data flag).
 */
export function buildIdMap(events: KanonEvent[]): IdMap {
  const map: IdMap = new Map();
  for (const event of events) {
    const linearId = event.data.linearId;
    if (typeof linearId !== "string") continue;
    const prev = map.get(linearId);
    const modelId = prev?.modelId ?? event.modelId;
    const raw = event.data.linearUpdatedAt;
    const updatedAt = typeof raw === "string" ? raw : prev?.updatedAt;
    let archived = prev?.archived;
    if (event.op === "archive") archived = true;
    else if (event.op === "unarchive") archived = false;
    map.set(linearId, {
      modelId,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(archived === undefined ? {} : { archived }),
    });
  }
  return map;
}

/**
 * Append events to their monthly segments, grouped by segmentName(ts).
 * True O_APPEND writes: a crash mid-import can at worst leave a partial final
 * line (which `kanon validate` flags) — it can never truncate committed
 * history the way a read-modify-write could.
 */
export function appendEvents(dir: string, events: KanonEvent[]): void {
  const eventsDir = join(dir, "events");
  mkdirSync(eventsDir, { recursive: true });
  const bySegment = new Map<string, string[]>();
  for (const event of events) {
    const segment = segmentName(event.ts);
    const lines = bySegment.get(segment) ?? [];
    lines.push(serializeEvent(event));
    bySegment.set(segment, lines);
  }
  for (const [segment, lines] of bySegment) {
    appendFileSync(join(eventsDir, segment), `${lines.join("\n")}\n`);
  }
}

/**
 * Merge imported issue-number highs into meta.json displayCounters, so the
 * CLI's local identifier allocation (BRO-1647, ...) starts above imported
 * history instead of minting BRO-1 over it. Monotonic: existing counters are
 * never lowered. Returns the merged counters.
 */
export function seedDisplayCounters(
  dir: string,
  counters: Record<string, number>,
): Record<string, number> {
  const path = join(dir, "meta.json");
  const meta = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const existingRaw = meta.displayCounters;
  const existing: Record<string, number> =
    typeof existingRaw === "object" && existingRaw !== null && !Array.isArray(existingRaw)
      ? (existingRaw as Record<string, number>)
      : {};
  const merged = { ...existing };
  for (const [key, value] of Object.entries(counters)) {
    merged[key] = Math.max(existing[key] ?? 0, value);
  }
  meta.displayCounters = merged;
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
  return merged;
}
