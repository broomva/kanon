/**
 * Log loading — read every events/*.jsonl segment of a data repo and merge
 * them into the canonical ULID-ordered stream.
 *
 * Segments are a ROUTING convention, never an ordering guarantee: imports
 * append newer-ULID events into old-month files, so no segment is immutable
 * and no per-segment order can be assumed. The only order is ULID, which is
 * exactly what `unionMergeWithReport` produces (sorted + deduped — the
 * contract `replay` requires). Conflicting duplicate ids are resolved by the
 * merge tie-break; callers surface `report.conflicts` as a warning and
 * proceed with the canonical stream.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type KanonEvent,
  type MergeReport,
  parseEventLine,
  unionMergeWithReport,
} from "@kanon/core";

/**
 * Load the full event log of a data repo: every `events/*.jsonl` segment,
 * union-merged into one sorted, deduped stream. A missing `events/` directory
 * is an empty log, not an error.
 */
export function loadLog(dataRepoDir: string): MergeReport {
  const eventsDir = join(dataRepoDir, "events");
  let segments: string[];
  try {
    segments = readdirSync(eventsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch {
    return unionMergeWithReport();
  }
  const streams: KanonEvent[][] = [];
  for (const segment of segments) {
    const lines = readFileSync(join(eventsDir, segment), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    streams.push(lines.map((line) => parseEventLine(line)));
  }
  return unionMergeWithReport(...streams);
}
