/**
 * Union merge — the replication heart.
 *
 * Replicas exchange whole event streams (JSONL segments in a git data-repo).
 * Merge is a pure function over those streams: concatenate, dedupe by event
 * id, sort ascending by id. ULIDs sort lexicographically in creation-time
 * order, so the sorted union is the canonical total order that every replica
 * converges on — the contract `replay` depends on.
 *
 * Duplicate ids that carry DIFFERENT content (a byzantine or misbehaving
 * producer — ULIDs make honest collisions vanishingly unlikely) resolve by a
 * content tie-break: the occurrence with the lexicographically smaller
 * canonical serialization (`stableStringify`) wins. That makes the merged
 * `events` array a pure function of the input SET, independent of stream
 * arrangement or arrival order — required for convergence.
 */

import type { KanonEvent } from "./index";
import { stableStringify } from "./stable";

/** A duplicated event id whose content differed between occurrences. */
export interface MergeConflict {
  /** The duplicated event id. */
  id: string;
  /** The occurrence that won this comparison (smaller canonical serialization). */
  kept: KanonEvent;
  /** The conflicting occurrence that lost this comparison. */
  discarded: KanonEvent;
}

export interface MergeReport {
  /** Deduped union of all input streams, sorted ascending by event id. */
  events: KanonEvent[];
  /**
   * Duplicate ids whose content differed between occurrences. Event ids are
   * ULIDs, so this should never happen in a healthy log — a non-empty list
   * means a producer is misbehaving. The winner is chosen deterministically
   * (smallest canonical serialization), so `events` converges regardless;
   * the conflict list is diagnostic and its pairwise entries/order may vary
   * with stream arrangement.
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
 * Merge event streams and report duplicates. Dedupe is by event id. Content
 * identity is judged by key-order-insensitive serialization, so the same
 * event re-serialized with reordered keys is an identical duplicate, not a
 * conflict. Conflicting content resolves by the tie-break documented above
 * — arrangement-independent, first-arrival plays no role.
 */
export function unionMergeWithReport(...streams: Iterable<KanonEvent>[]): MergeReport {
  const byId = new Map<string, KanonEvent>();
  const conflicts: MergeConflict[] = [];
  let duplicatesDropped = 0;
  for (const stream of streams) {
    for (const event of stream) {
      const current = byId.get(event.id);
      if (current === undefined) {
        byId.set(event.id, event);
        continue;
      }
      duplicatesDropped++;
      const currentKey = stableStringify(current);
      const eventKey = stableStringify(event);
      if (currentKey === eventKey) {
        continue; // identical duplicate — normal after sync overlap
      }
      const [kept, discarded] = eventKey < currentKey ? [event, current] : [current, event];
      byId.set(event.id, kept);
      conflicts.push({ id: event.id, kept, discarded });
    }
  }
  const events = [...byId.values()].sort(compareById);
  return { events, conflicts, duplicatesDropped };
}

/**
 * ULID-ordered union of event streams: concatenate, dedupe by event id
 * (content tie-break on conflicting duplicates), sort ascending by id. The
 * output satisfies the strictly-ascending + deduped contract that `replay`
 * requires.
 */
export function unionMerge(...streams: Iterable<KanonEvent>[]): KanonEvent[] {
  return unionMergeWithReport(...streams).events;
}
