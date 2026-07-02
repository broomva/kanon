/**
 * Union merge — the replication heart.
 *
 * Replicas exchange whole event streams (JSONL segments in a git data-repo).
 * Merge is a pure function over those streams: concatenate, dedupe by event
 * id, sort ascending by id. ULIDs sort lexicographically in creation-time
 * order, so the sorted union is the canonical total order that every replica
 * converges on — the contract `replay` depends on.
 */

import type { KanonEvent } from "./index";
import { stableStringify } from "./stable";

/** A duplicated event id whose content differed between occurrences. */
export interface MergeConflict {
  /** The duplicated event id. */
  id: string;
  /** The occurrence that was kept (first in stream order). */
  kept: KanonEvent;
  /** The conflicting occurrence that was discarded. */
  discarded: KanonEvent;
}

export interface MergeReport {
  /** Deduped union of all input streams, sorted ascending by event id. */
  events: KanonEvent[];
  /**
   * Duplicate ids whose content differed from the first occurrence. Event
   * ids are ULIDs, so this should never happen in a healthy log — a
   * non-empty list means a producer is misbehaving. The first occurrence
   * still wins deterministically; the conflict is surfaced, not resolved.
   */
  conflicts: MergeConflict[];
  /** Total duplicate occurrences dropped (identical and conflicting). */
  duplicatesDropped: number;
}

function compareById(a: KanonEvent, b: KanonEvent): number {
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

/**
 * Merge event streams and report duplicates. Dedupe is by event id — the
 * first occurrence (in stream, then element order) wins; later occurrences
 * are dropped. Content identity is judged by key-order-insensitive
 * serialization, so the same event re-serialized with reordered keys is an
 * identical duplicate, not a conflict.
 */
export function unionMergeWithReport(...streams: Iterable<KanonEvent>[]): MergeReport {
  const byId = new Map<string, KanonEvent>();
  const conflicts: MergeConflict[] = [];
  let duplicatesDropped = 0;
  for (const stream of streams) {
    for (const event of stream) {
      const kept = byId.get(event.id);
      if (kept === undefined) {
        byId.set(event.id, event);
        continue;
      }
      duplicatesDropped++;
      if (stableStringify(kept) !== stableStringify(event)) {
        conflicts.push({ id: event.id, kept, discarded: event });
      }
    }
  }
  const events = [...byId.values()].sort(compareById);
  return { events, conflicts, duplicatesDropped };
}

/**
 * ULID-ordered union of event streams: concatenate, dedupe by event id
 * (first occurrence wins), sort ascending by id. The output satisfies the
 * sorted + deduped contract that `replay` requires.
 */
export function unionMerge(...streams: Iterable<KanonEvent>[]): KanonEvent[] {
  return unionMergeWithReport(...streams).events;
}
