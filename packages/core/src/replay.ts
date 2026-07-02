/**
 * Deterministic replay — fold a merged event stream into a WorldState.
 *
 * ## Input contract
 *
 * `replay` assumes its input is **sorted ascending by event id and deduped**
 * — exactly what `unionMerge` produces. Under that contract, skipping events
 * with `id <= state.cursor` is safe (anything at or below the cursor has
 * already been applied), which makes replay resumable from a snapshot and
 * idempotent under re-application. Feeding an unsorted or un-deduped stream
 * violates the contract; run `unionMerge` first, or use `replayMerged`.
 *
 * ## Convergence rules (per-field last-write-wins)
 *
 * Every scalar write is guarded by an LWW register keyed by
 * `"${model} ${id} ${field}"` in `WorldState.fieldVersions`; a write lands
 * iff its event id is strictly greater (string compare = ULID temporal
 * order) than the stored version. Archive state and tombstones are LWW
 * registers on the reserved pseudo-fields `__archived` and `__deleted`.
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

/** Reserved pseudo-field carrying archive state through the LWW machinery. */
export const ARCHIVED_FIELD = "__archived";
/** Reserved pseudo-field carrying the tombstone through the LWW machinery. */
export const DELETED_FIELD = "__deleted";
/**
 * Data fields with this prefix are reserved for replay pseudo-fields and are
 * ignored by `applyEvent` — they never reach `Entity.fields` and cannot
 * clobber the archive/tombstone registers.
 */
export const RESERVED_FIELD_PREFIX = "__";

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
  /** `ts` of the first event that materialized this entity. */
  createdAt: string;
  /** `ts` of the latest (highest-id) event applied to this entity. */
  updatedAt: string;
  /** Highest event id applied to this entity. */
  lastEventId: string;
}

export interface WorldState {
  entities: Map<Model, Map<string, Entity>>;
  /**
   * LWW registers: `"${model} ${id} ${field}"` -> winning event id. The
   * encoding is unambiguous because `model` (enum) and `id` (ULID) never
   * contain spaces; `field` is everything after the second space.
   */
  fieldVersions: Map<string, string>;
  /** Highest event id ever applied via `replay`, or null for a fresh state. */
  cursor: string | null;
}

export function createWorldState(): WorldState {
  return { entities: new Map(), fieldVersions: new Map(), cursor: null };
}

/** LWW register key for one field of one entity. */
export function fieldVersionKey(model: Model, id: string, field: string): string {
  return `${model} ${id} ${field}`;
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
 * Apply one event to the state, mutating it. Deterministic: per-field LWW
 * guards mean field values converge regardless of application order; the
 * bookkeeping columns (`createdAt`, `updatedAt`, `lastEventId`) are
 * order-independent too (`createdAt` = first materialization, the others
 * track the highest event id seen).
 *
 * `relate` follows `create` semantics and `unrelate` follows `delete`
 * semantics — conventionally used for `issue_relation` entities carrying
 * `{ type, issueId, relatedIssueId }`.
 */
export function applyEvent(state: WorldState, event: KanonEvent): WorldState {
  const entity = getOrCreateEntity(state, event);
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
  return state;
}

/**
 * Fold events into a state (mutating `initial` when given). Requires the
 * sorted + deduped contract documented above; events with
 * `id <= state.cursor` are skipped as already applied.
 */
export function replay(events: Iterable<KanonEvent>, initial?: WorldState): WorldState {
  const state = initial ?? createWorldState();
  for (const event of events) {
    if (state.cursor !== null && event.id <= state.cursor) {
      continue;
    }
    applyEvent(state, event);
    state.cursor = event.id;
  }
  return state;
}

/** Convenience: `replay(unionMerge(...streams))`. */
export function replayMerged(...streams: Iterable<KanonEvent>[]): WorldState {
  return replay(unionMerge(...streams));
}
