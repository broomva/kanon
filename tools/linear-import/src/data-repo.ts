/**
 * Minimal data-repo I/O for the importer — deliberately local to this package
 * (tools never import from @kanon/cli). The layout matches `kanon init`:
 *
 *   <repo>/meta.json            workspace slug + schema version
 *   <repo>/events/YYYY-MM.jsonl monthly append-only segments
 *
 * loadEvents returns the log in ULID order (the log's total order), so
 * buildIdMap folds create → update chains chronologically and the last
 * `linearUpdatedAt` seen for a linearId wins as the idempotency watermark.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Fold the log into linearId → {modelId, updatedAt}. Any event whose data
 * carries a `linearId` claims the mapping (create, update, relate, archive —
 * the op doesn't matter; the first event to name a linearId fixes its modelId).
 * `linearUpdatedAt`, when present, advances the idempotency watermark; events
 * without it (e.g. archive, parent fixups) never clobber an existing one.
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
    map.set(linearId, updatedAt === undefined ? { modelId } : { modelId, updatedAt });
  }
  return map;
}

/** Append events to their monthly segments, grouped by segmentName(ts). */
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
    const path = join(eventsDir, segment);
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      // first event in this segment
    }
    writeFileSync(path, `${existing}${lines.join("\n")}\n`);
  }
}
