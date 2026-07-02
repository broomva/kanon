/**
 * Test-only helpers for the merge/replay/snapshot suites. Not part of the
 * public API — deliberately not re-exported from index.ts.
 *
 * Determinism strategy: property tests derive every event id from a
 * fast-check-generated integer via `testId`, which encodes the integer as a
 * fixed-width Crockford-base32 string. Ids are valid per ULID_PATTERN,
 * globally unique per sequence number, and lexicographically ordered by that
 * number — so "higher seq" always means "later in ULID total order" without
 * any wall-clock or RNG input.
 */

import { createEvent, type EventActor, type KanonEvent, type Model, type Op } from "./index";
import type { Entity, WorldState } from "./replay";

export const TEST_ACTOR: EventActor = { type: "agent", id: "test-agent", surface: "cli" };

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LENGTH = 26;

/** Deterministic ULID-shaped id, lexicographically ordered by `n` (n >= 0). */
export function testId(n: number): string {
  let out = "";
  let t = n;
  for (let i = 0; i < ID_LENGTH; i++) {
    out = ENCODING.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Deterministic timestamp, strictly increasing with `n`. */
export function testTs(n: number): string {
  return new Date(1_750_000_000_000 + n * 1000).toISOString();
}

/** Entity-pool member `i` as a modelId (offset keeps it clear of event ids). */
export function entityId(i: number): string {
  return testId(1_000_000 + i);
}

export interface EventSpec {
  /** Unique per event; determines id, ts, and position in the total order. */
  seq: number;
  op: Op;
  model: Model;
  /** Index into the shared entity-id pool. */
  entity: number;
  data?: Record<string, unknown>;
}

export function makeEvent(spec: EventSpec): KanonEvent {
  return createEvent({
    workspace: "test",
    actor: TEST_ACTOR,
    op: spec.op,
    model: spec.model,
    modelId: entityId(spec.entity),
    data: spec.data ?? {},
    id: testId(spec.seq),
    ts: testTs(spec.seq),
  });
}

/** Entity lookup that throws instead of returning undefined. */
export function mustGetEntity(state: WorldState, model: Model, id: string): Entity {
  const entity = state.entities.get(model)?.get(id);
  if (entity === undefined) {
    throw new Error(`entity ${model}/${id} not found`);
  }
  return entity;
}
