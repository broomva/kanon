/**
 * Deterministic replay — fold a merged event stream into a WorldState.
 *
 * ## Input contract (the REAL precondition)
 *
 * `replay` requires its input **strictly ascending by event id and deduped**
 * — exactly what `unionMerge` produces. Violations throw `ReplayOrderError`
 * immediately (fail-fast; out-of-order input is never silently skipped).
 *
 * ## Resuming (cursor + applied-set fingerprint)
 *
 * A cursor alone cannot make resumption sound: a merged log can legally
 * *gain events with ids below the cursor* (a sync pulls in older events from
 * another replica), and skipping everything `<= cursor` would silently drop
 * them. `WorldState` therefore carries an order-independent fingerprint of
 * the applied event-id set — `appliedCount` plus `appliedHash` (XOR-fold of
 * FNV-1a 64 over each applied id). A resumed `replay` accepts exactly two
 * stream shapes:
 *
 *   1. a **pure suffix** — every id > cursor (e.g. `sorted.slice(k)` after
 *      restoring the snapshot taken at k), or
 *   2. a **full merged log** — whose prefix at or below the cursor matches
 *      the fingerprint (same count, same hash) and is therefore exactly the
 *      set already applied.
 *
 * Anything else throws `ReplayDivergenceError` *before mutating the state*:
 * the log's history changed underneath the cursor and the only sound move is
 * a full rebuild — replay the complete merged log into a fresh WorldState.
 *
 * ## Convergence rules (per-field last-write-wins)
 *
 * Every scalar write is guarded by an LWW register keyed
 * `"${model} ${id} ${field}"` in `WorldState.fieldVersions`; a write lands
 * iff its event id is strictly greater (string compare = ULID temporal
 * order) than the stored version. Archive state and tombstones are LWW
 * registers on the reserved pseudo-fields `__archived` and `__deleted`;
 * `createdAt` is an LWW-**MIN** register on `__created` (the smallest
 * introducing event id wins). All entity bookkeeping is therefore
 * commutative under raw `applyEvent`: fields, archive state, tombstones,
 * `createdAt` (min id), and `updatedAt`/`lastEventId` (max id) all converge
 * regardless of application order.
 *
 * ## Resurrection semantics (documented choice)
 *
 * `delete` tombstones (`deleted: true`, entity retained). A later `create`
 * (or `relate`) with a **higher event id** resurrects the entity: create
 * asserts existence, so it competes on the `__deleted` register. `update`
 * never resurrects — it mutates fields (LWW per field) but leaves the
 * tombstone in place. Either choice is deterministic; this one matches the
 * intuition that re-creating an entity revives it while stray late updates
 * to a deleted entity do not.
 */

import type { KanonEvent, Model } from "./index";
import { unionMerge } from "./merge";
import { fnv1a64 } from "./stable";

/** Reserved pseudo-field carrying archive state through the LWW machinery. */
export const ARCHIVED_FIELD = "__archived";
/** Reserved pseudo-field carrying the tombstone through the LWW machinery. */
export const DELETED_FIELD = "__deleted";
/** Reserved pseudo-field carrying the LWW-MIN `createdAt` register. */
export const CREATED_FIELD = "__created";
/**
 * Data fields with this prefix are reserved for replay pseudo-fields and are
 * ignored by `applyEvent` — they never reach `Entity.fields` and cannot
 * clobber the archive/tombstone/created registers.
 */
export const RESERVED_FIELD_PREFIX = "__";

/** `appliedHash` of a state with no applied events (XOR identity). */
export const EMPTY_APPLIED_HASH = "0000000000000000";

/** Thrown when `replay` input violates the strictly-ascending, deduped contract. */
export class ReplayOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayOrderError";
  }
}

/**
 * Thrown when a resumed `replay` detects that the incoming stream's prefix
 * at or below the cursor is not the set of events already applied — the log
 * gained or changed history underneath the cursor. The state was NOT
 * mutated. Recovery: full rebuild — replay the complete merged log into a
 * fresh WorldState (or restore an older snapshot known to precede the
 * divergence).
 */
export class ReplayDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayDivergenceError";
  }
}

export interface Entity {
  /** ULID entity key (`event.modelId`). */
  id: string;
  model: Model;
  /** Materialized scalar fields, each governed by its own LWW register. */
  fields: Record<string, unknown>;
  /** `ts` of the winning archive event, or null when not archived. */
  archivedAt: string | null;
  /** Tombstone — entity is retained but marked deleted. */
  deleted: boolean;
  /** `ts` of the smallest-id event applied to this entity (LWW-MIN on `__created`). */
  createdAt: string;
  /** `ts` of the highest-id event applied to this entity. */
  updatedAt: string;
  /** Highest event id applied to this entity. */
  lastEventId: string;
}

export interface WorldState {
  entities: Map<Model, Map<string, Entity>>;
  /**
   * LWW registers: `"${model} ${id} ${field}"` -> winning event id. The
   * encoding is unambiguous because `model` (enum) and `id` (ULID) never
   * contain spaces; `field` is everything after the second space. All
   * registers are max-wins except the `__created` family, which is min-wins.
   */
  fieldVersions: Map<string, string>;
  /** Highest event id ever applied via `replay`, or null for a fresh state. */
  cursor: string | null;
  /** Number of events ever applied (via `replay` or raw `applyEvent`). */
  appliedCount: number;
  /**
   * Order-independent fingerprint of the applied event-id set: XOR-fold of
   * `fnv1a64(id)` across applied events, 16-char lowercase hex. Together
   * with `appliedCount` this lets a resumed replay verify that a stream's
   * prefix at or below the cursor is exactly the history already applied.
   */
  appliedHash: string;
}

export function createWorldState(): WorldState {
  return {
    entities: new Map(),
    fieldVersions: new Map(),
    cursor: null,
    appliedCount: 0,
    appliedHash: EMPTY_APPLIED_HASH,
  };
}

/** LWW register key for one field of one entity. */
export function fieldVersionKey(model: Model, id: string, field: string): string {
  return `${model} ${id} ${field}`;
}

/** XOR-fold one event id into an applied-set fingerprint. */
function foldAppliedId(hash: string, eventId: string): string {
  const folded = BigInt(`0x${hash}`) ^ BigInt(`0x${fnv1a64(eventId)}`);
  return folded.toString(16).padStart(16, "0");
}

/**
 * Last-write-wins gate: returns true and records `eventId` as the new
 * version iff it is strictly greater than the stored version (or the
 * register is empty). Ties lose — equal ids are the same event.
 */
function lwwWins(state: WorldState, key: string, eventId: string): boolean {
  const current = state.fieldVersions.get(key);
  if (current !== undefined && current >= eventId) {
    return false;
  }
  state.fieldVersions.set(key, eventId);
  return true;
}

/** LWW-MIN gate: smallest event id wins (used by the `__created` register). */
function lwwMinWins(state: WorldState, key: string, eventId: string): boolean {
  const current = state.fieldVersions.get(key);
  if (current !== undefined && current <= eventId) {
    return false;
  }
  state.fieldVersions.set(key, eventId);
  return true;
}

function getOrCreateEntity(state: WorldState, event: KanonEvent): Entity {
  let byId = state.entities.get(event.model);
  if (byId === undefined) {
    byId = new Map();
    state.entities.set(event.model, byId);
  }
  let entity = byId.get(event.modelId);
  if (entity === undefined) {
    entity = {
      id: event.modelId,
      model: event.model,
      fields: {},
      archivedAt: null,
      deleted: false,
      createdAt: event.ts,
      updatedAt: event.ts,
      lastEventId: event.id,
    };
    byId.set(event.modelId, entity);
  }
  return entity;
}

function applyFields(state: WorldState, entity: Entity, event: KanonEvent): void {
  for (const [field, value] of Object.entries(event.data)) {
    if (field.startsWith(RESERVED_FIELD_PREFIX)) {
      continue;
    }
    if (lwwWins(state, fieldVersionKey(event.model, event.modelId, field), event.id)) {
      entity.fields[field] = value;
    }
  }
}

function touch(entity: Entity, event: KanonEvent): void {
  if (event.id > entity.lastEventId) {
    entity.lastEventId = event.id;
    entity.updatedAt = event.ts;
  }
}

/**
 * Apply one event to the state, mutating it. Commutative: per-field LWW
 * guards mean field values converge regardless of application order, and
 * the bookkeeping columns do too — `createdAt` is an LWW-MIN register
 * (smallest introducing event id wins), `updatedAt`/`lastEventId` track the
 * highest event id seen. Also maintains the applied-set fingerprint
 * (`appliedCount`/`appliedHash`); callers must not apply the same event
 * twice (`replay` enforces this via its contract).
 *
 * `relate` follows `create` semantics and `unrelate` follows `delete`
 * semantics — conventionally used for `issue_relation` entities carrying
 * `{ type, issueId, relatedIssueId }`.
 */
export function applyEvent(state: WorldState, event: KanonEvent): WorldState {
  const entity = getOrCreateEntity(state, event);
  if (lwwMinWins(state, fieldVersionKey(event.model, event.modelId, CREATED_FIELD), event.id)) {
    entity.createdAt = event.ts;
  }
  switch (event.op) {
    case "create":
    case "relate": {
      // Create asserts existence: it competes on the tombstone register, so
      // a create with a higher id than a delete resurrects the entity.
      if (lwwWins(state, fieldVersionKey(event.model, event.modelId, DELETED_FIELD), event.id)) {
        entity.deleted = false;
      }
      applyFields(state, entity, event);
      break;
    }
    case "update": {
      applyFields(state, entity, event);
      break;
    }
    case "archive":
    case "unarchive": {
      if (lwwWins(state, fieldVersionKey(event.model, event.modelId, ARCHIVED_FIELD), event.id)) {
        entity.archivedAt = event.op === "archive" ? event.ts : null;
      }
      break;
    }
    case "delete":
    case "unrelate": {
      if (lwwWins(state, fieldVersionKey(event.model, event.modelId, DELETED_FIELD), event.id)) {
        entity.deleted = true;
      }
      break;
    }
  }
  touch(entity, event);
  state.appliedCount += 1;
  state.appliedHash = foldAppliedId(state.appliedHash, event.id);
  return state;
}

function verifyResumePrefix(state: WorldState, prefixCount: number, prefixHash: string): void {
  if (prefixCount === 0) {
    return; // pure suffix extension — nothing below the cursor to verify
  }
  if (prefixCount === state.appliedCount && prefixHash === state.appliedHash) {
    return; // prefix is exactly the applied set
  }
  throw new ReplayDivergenceError(
    `resumed stream's prefix at or below cursor ${String(state.cursor)} does not match the ` +
      `applied set (prefix: ${prefixCount} events, hash ${prefixHash}; applied: ` +
      `${state.appliedCount} events, hash ${state.appliedHash}). The merged log gained or ` +
      "changed history below the cursor — full rebuild required: replay the complete merged " +
      "log into a fresh WorldState.",
  );
}

/**
 * Fold events into a state (mutating `initial` when given). Input must be
 * strictly ascending by event id and deduped (see the module contract);
 * violations throw `ReplayOrderError`. When resuming (`state.cursor` set),
 * the stream must be a pure suffix or a full merged log whose prefix
 * matches the applied-set fingerprint; otherwise `ReplayDivergenceError` is
 * thrown before any mutation.
 */
export function replay(events: Iterable<KanonEvent>, initial?: WorldState): WorldState {
  const state = initial ?? createWorldState();
  let previousId: string | null = null;
  let prefixCount = 0;
  let prefixHash = EMPTY_APPLIED_HASH;
  let prefixVerified = state.cursor === null;
  for (const event of events) {
    if (previousId !== null && event.id <= previousId) {
      throw new ReplayOrderError(
        `replay input must be strictly ascending by event id and deduped: saw ${event.id} ` +
          `after ${previousId} — run unionMerge first`,
      );
    }
    previousId = event.id;
    if (!prefixVerified && state.cursor !== null && event.id <= state.cursor) {
      prefixCount += 1;
      prefixHash = foldAppliedId(prefixHash, event.id);
      continue;
    }
    if (!prefixVerified) {
      verifyResumePrefix(state, prefixCount, prefixHash);
      prefixVerified = true;
    }
    applyEvent(state, event);
    state.cursor = event.id;
  }
  if (!prefixVerified) {
    verifyResumePrefix(state, prefixCount, prefixHash);
  }
  return state;
}

/** Convenience: `replay(unionMerge(...streams))`. */
export function replayMerged(...streams: Iterable<KanonEvent>[]): WorldState {
  return replay(unionMerge(...streams));
}
