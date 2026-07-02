/**
 * Snapshots — plain-JSON projections of a WorldState.
 *
 * A snapshot is the resumption point for replay: restore it, then replay the
 * events after `cursor`. Snapshots are canonical-form JSON — every object's
 * keys/entries are emitted in sorted order (models, entity ids, entity
 * fields, LWW registers) and entity records use a fixed property order, so
 * two identical states always serialize to identical bytes. That property is
 * what makes `stateChecksum` a valid convergence probe.
 */

import type { Model } from "./index";
import type { Entity, WorldState } from "./replay";
import { fnv1a64, stableStringify } from "./stable";

export const SNAPSHOT_VERSION = 1 as const;

export interface SnapshotV1 {
  v: typeof SNAPSHOT_VERSION;
  /** Replay cursor — highest event id folded into this state. */
  cursor: string | null;
  /** model -> entity id -> entity; all keys sorted. Keys are `Model` values. */
  entities: Record<string, Record<string, Entity>>;
  /** LWW registers (`"${model} ${id} ${field}"` -> event id); keys sorted. */
  fieldVersions: Record<string, string>;
}

function snapshotEntity(entity: Entity): Entity {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(entity.fields).sort()) {
    fields[key] = entity.fields[key];
  }
  // Fixed property order so identical entities serialize identically.
  return {
    id: entity.id,
    model: entity.model,
    fields,
    archivedAt: entity.archivedAt,
    deleted: entity.deleted,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    lastEventId: entity.lastEventId,
  };
}

/**
 * Project a WorldState to plain JSON-serializable form. Field values are
 * copied by reference — they originate in event `data` and are treated as
 * immutable throughout the core.
 */
export function takeSnapshot(state: WorldState): SnapshotV1 {
  const entities: Record<string, Record<string, Entity>> = {};
  for (const model of [...state.entities.keys()].sort()) {
    const byId = state.entities.get(model);
    if (byId === undefined || byId.size === 0) {
      continue;
    }
    const projected: Record<string, Entity> = {};
    for (const id of [...byId.keys()].sort()) {
      const entity = byId.get(id);
      if (entity !== undefined) {
        projected[id] = snapshotEntity(entity);
      }
    }
    entities[model] = projected;
  }
  const fieldVersions: Record<string, string> = {};
  for (const key of [...state.fieldVersions.keys()].sort()) {
    const version = state.fieldVersions.get(key);
    if (version !== undefined) {
      fieldVersions[key] = version;
    }
  }
  return { v: SNAPSHOT_VERSION, cursor: state.cursor, entities, fieldVersions };
}

/** Rebuild a live WorldState from a snapshot. Throws on unknown versions. */
export function restoreSnapshot(snap: SnapshotV1): WorldState {
  if (snap.v !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version: ${String((snap as { v: unknown }).v)}`);
  }
  const entities = new Map<Model, Map<string, Entity>>();
  for (const [model, byIdRecord] of Object.entries(snap.entities)) {
    const byId = new Map<string, Entity>();
    for (const [id, entity] of Object.entries(byIdRecord)) {
      byId.set(id, { ...entity, fields: { ...entity.fields } });
    }
    // Snapshot entity keys are Model values by construction (see SnapshotV1).
    entities.set(model as Model, byId);
  }
  return {
    entities,
    fieldVersions: new Map(Object.entries(snap.fieldVersions)),
    cursor: snap.cursor,
  };
}

/**
 * Convergence checksum: FNV-1a 64-bit over the canonical (sorted-key)
 * serialization of the snapshot. Two replicas hold the same state iff their
 * checksums match (modulo the non-cryptographic hash caveat).
 */
export function stateChecksum(state: WorldState): string {
  return fnv1a64(stableStringify(takeSnapshot(state)));
}
