/**
 * SQLite projection — a DISPOSABLE cache of the canonical event log.
 *
 * The log is the source of truth; `state.db` can be deleted at any time and
 * rebuilt with identical content (the data repo's .gitignore excludes it from
 * history). `refresh()` compares the log's head id + event count + a
 * content hash (XOR-fold of each merged event's canonical serialization —
 * head/count alone would miss a conflicting duplicate whose content wins the
 * merge tie-break without changing either) against a `projection_meta`
 * table and, on ANY mismatch, drops every table and rebuilds from a fresh
 * full replay — genesis onward, never snapshot-resume. A log that reports
 * merge conflicts always rebuilds. Full rebuild sidesteps the entire
 * `ReplayDivergenceError` class (a merged log can legally gain events below
 * any cursor), and thousands of events replay in milliseconds, so v1 buys
 * correctness for free.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  type Entity,
  fnv1a64,
  type KanonEvent,
  type Model,
  replay,
  stableStringify,
} from "@kanon/core";
import { loadLog } from "./log";
import { MODEL_TABLES, PROJECTION_SCHEMA_VERSION, schemaDdl, type TableSpec } from "./schema";

export interface RefreshResult {
  /** True when the tables were dropped and rebuilt from a full replay. */
  rebuilt: boolean;
  /** Events in the merged canonical stream. */
  eventCount: number;
  /** Highest event id in the stream, or null for an empty log. */
  headId: string | null;
  /** Conflicting duplicate ids the union merge tie-broke (0 in a healthy log). */
  conflictCount: number;
}

export interface ProjectionOptions {
  /** Receives diagnostics (merge conflicts). Defaults to console.warn. */
  onWarn?: (message: string) => void;
}

export interface Projection {
  readonly db: Database;
  readonly dir: string;
  /** Rebuild iff the log's head id / event count moved (or schema changed). */
  refresh(): RefreshResult;
  /** Unconditional drop + full rebuild from genesis. */
  rebuild(): RefreshResult;
  close(): void;
}

interface ProjectionMeta {
  schemaVersion: number;
  headId: string | null;
  eventCount: number;
  contentHash: string;
}

type Binding = string | number | null;

/**
 * Order-independent content fingerprint of the merged stream: XOR-fold of
 * FNV-1a 64 over each event's canonical serialization. Head id + count are
 * NOT enough for staleness: a conflicting duplicate that wins the merge
 * tie-break changes canonical CONTENT while leaving both unchanged.
 */
function contentHash(events: Iterable<KanonEvent>): string {
  let hash = 0n;
  for (const event of events) {
    hash ^= BigInt(`0x${fnv1a64(stableStringify(event))}`);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Quote an identifier read back from sqlite_master for safe interpolation. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function readMeta(db: Database): ProjectionMeta | undefined {
  const table = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_meta'",
    )
    .get();
  if (table === null) {
    return undefined;
  }
  let rows: { key: string; value: string }[];
  try {
    rows = db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM projection_meta")
      .all();
  } catch {
    // An incompatible projection_meta shape (older cache, foreign schema) is
    // just a stale disposable cache — signal "rebuild", never throw.
    return undefined;
  }
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const schemaVersion = Number(byKey.get("schema_version"));
  const eventCount = Number(byKey.get("event_count"));
  const headId = byKey.get("head_id");
  const storedHash = byKey.get("content_hash");
  if (
    !Number.isInteger(schemaVersion) ||
    !Number.isInteger(eventCount) ||
    headId === undefined ||
    storedHash === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion,
    headId: headId === "" ? null : headId,
    eventCount,
    contentHash: storedHash,
  };
}

function dropAllTables(db: Database): void {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  for (const { name } of tables) {
    db.run(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
  }
}

/**
 * Split entity fields into typed column bindings + the data_json overflow.
 * A field only feeds its column when the runtime type matches the column
 * kind; mismatched values stay in data_json rather than corrupting a column.
 */
function bindColumns(
  spec: TableSpec,
  fields: Record<string, unknown>,
  skipFields: ReadonlySet<string>,
): { values: Binding[]; rest: Record<string, unknown> } {
  const consumed = new Set<string>(skipFields);
  const values: Binding[] = [];
  for (const column of spec.columns) {
    const value = fields[column.field];
    if (column.kind === "text" && typeof value === "string") {
      values.push(value);
      consumed.add(column.field);
    } else if (column.kind === "number" && typeof value === "number" && Number.isFinite(value)) {
      values.push(value);
      consumed.add(column.field);
    } else {
      values.push(null);
      if (value === null) {
        consumed.add(column.field);
      }
    }
  }
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!consumed.has(key)) {
      rest[key] = value;
    }
  }
  return { values, rest };
}

function bookkeepingBindings(entity: Entity, rest: Record<string, unknown>): Binding[] {
  return [
    entity.createdAt,
    entity.updatedAt,
    entity.archivedAt,
    entity.deleted ? 1 : 0,
    Object.keys(rest).length > 0 ? stableStringify(rest) : null,
  ];
}

const NO_SKIP: ReadonlySet<string> = new Set();
const ISSUE_SKIP: ReadonlySet<string> = new Set(["labelIds"]);

function insertEntities(db: Database, model: Model, entities: Map<string, Entity>): void {
  const spec = MODEL_TABLES[model];
  const ids = [...entities.keys()].sort();
  if (spec === undefined) {
    const insert = db.prepare(
      "INSERT INTO other_entities (model, id, created_at, updated_at, archived_at, deleted, " +
        "data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const id of ids) {
      const entity = entities.get(id);
      if (entity === undefined) continue;
      insert.run(model, id, ...bookkeepingBindings(entity, entity.fields));
    }
    return;
  }
  const columns = spec.columns.map((column) => column.column).join(", ");
  const marks = spec.columns.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO ${spec.table} (id, ${columns}, created_at, updated_at, archived_at, deleted, ` +
      `data_json) VALUES (?, ${marks}, ?, ?, ?, ?, ?)`,
  );
  for (const id of ids) {
    const entity = entities.get(id);
    if (entity === undefined) continue;
    const { values, rest } = bindColumns(spec, entity.fields, NO_SKIP);
    insert.run(id, ...values, ...bookkeepingBindings(entity, rest));
  }
}

/**
 * Resolve an issue's labels from the OR-Set of `issue_label` edges unioned
 * with any legacy whole-array `labelIds` field. Each edge id is deterministic
 * per `(issueId, labelId)` (see `issueLabelId`), so a live edge attaches and a
 * tombstoned edge detaches — which is how a label carried only in the legacy
 * array gets removed (an unrelate on the deterministic id, with no prior
 * relate, reads here as "removed"). BRO-1678.
 */
function resolveLabelIds(entity: Entity, edges: Map<string, boolean> | undefined): string[] {
  const labels = new Set<string>();
  const legacy = entity.fields.labelIds;
  if (Array.isArray(legacy)) {
    for (const labelId of legacy) {
      if (typeof labelId === "string") labels.add(labelId);
    }
  }
  if (edges !== undefined) {
    for (const [labelId, deleted] of edges) {
      if (deleted) labels.delete(labelId);
      else labels.add(labelId);
    }
  }
  return [...labels];
}

/** Group live/tombstoned `issue_label` edges by issue: issueId → labelId → deleted. */
function indexLabelEdges(
  edgeEntities: Map<string, Entity> | undefined,
): Map<string, Map<string, boolean>> {
  const byIssue = new Map<string, Map<string, boolean>>();
  if (edgeEntities === undefined) return byIssue;
  for (const edge of edgeEntities.values()) {
    const issueId = edge.fields.issueId;
    const labelId = edge.fields.labelId;
    if (typeof issueId !== "string" || typeof labelId !== "string") continue;
    let byLabel = byIssue.get(issueId);
    if (byLabel === undefined) {
      byLabel = new Map();
      byIssue.set(issueId, byLabel);
    }
    // One entity per (issueId, labelId) by construction — deterministic id.
    byLabel.set(labelId, edge.deleted);
  }
  return byIssue;
}

function insertIssues(
  db: Database,
  issues: Map<string, Entity>,
  teamKeys: Map<string, string>,
  labelEdges: Map<string, Map<string, boolean>>,
): void {
  const spec = MODEL_TABLES.issue;
  if (spec === undefined) throw new Error("unreachable: issue table spec missing");
  const columns = spec.columns.map((column) => column.column).join(", ");
  const marks = spec.columns.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO issues (id, ${columns}, identifier, created_at, updated_at, archived_at, ` +
      `deleted, data_json) VALUES (?, ${marks}, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLabel = db.prepare(
    "INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)",
  );
  for (const id of [...issues.keys()].sort()) {
    const entity = issues.get(id);
    if (entity === undefined) continue;
    const { values, rest } = bindColumns(spec, entity.fields, ISSUE_SKIP);

    // identifier = team.key || '-' || number when both exist, else NULL.
    const teamId = entity.fields.teamId;
    const number = entity.fields.number;
    const key = typeof teamId === "string" ? teamKeys.get(teamId) : undefined;
    const identifier =
      key !== undefined && typeof number === "number" && Number.isFinite(number)
        ? `${key}-${number}`
        : null;

    insert.run(id, ...values, identifier, ...bookkeepingBindings(entity, rest));

    for (const labelId of resolveLabelIds(entity, labelEdges.get(id))) {
      insertLabel.run(id, labelId);
    }
  }
}

export function openProjection(dataRepoDir: string, options: ProjectionOptions = {}): Projection {
  const db = new Database(join(dataRepoDir, "state.db"), { create: true });
  // Concurrent CLI invocations rebuild against the same cache file; wait for
  // the write lock instead of throwing SQLITE_BUSY at the first contender.
  db.run("PRAGMA busy_timeout = 5000");
  const warn = options.onWarn ?? ((message: string) => console.warn(message));

  const rebuildFrom = (
    events: ReturnType<typeof loadLog>["events"],
    conflictCount: number,
    hash: string,
  ): RefreshResult => {
    const state = replay(events);
    const headId = events.at(-1)?.id ?? null;
    const run = db.transaction(() => {
      dropAllTables(db);
      for (const statement of schemaDdl()) {
        db.run(statement);
      }

      const teamKeys = new Map<string, string>();
      for (const [id, team] of state.entities.get("team") ?? new Map<string, Entity>()) {
        const key = team.fields.key;
        if (typeof key === "string") {
          teamKeys.set(id, key);
        }
      }

      const labelEdges = indexLabelEdges(state.entities.get("issue_label"));
      for (const [model, entities] of state.entities) {
        if (model === "issue") {
          insertIssues(db, entities, teamKeys, labelEdges);
        } else {
          insertEntities(db, model, entities);
        }
      }

      const setMeta = db.prepare(
        "INSERT OR REPLACE INTO projection_meta (key, value) VALUES (?, ?)",
      );
      setMeta.run("schema_version", String(PROJECTION_SCHEMA_VERSION));
      setMeta.run("head_id", headId ?? "");
      setMeta.run("event_count", String(events.length));
      setMeta.run("content_hash", hash);
    });
    // IMMEDIATE, not deferred: a deferred transaction starts with a read
    // lock and upgrades to a write lock mid-flight — when two connections
    // race, SQLite reports the potential deadlock as an INSTANT
    // SQLITE_BUSY that BYPASSES busy_timeout. Taking the write lock up
    // front makes concurrent rebuilds queue on the timeout instead.
    run.immediate();
    return { rebuilt: true, eventCount: events.length, headId, conflictCount };
  };

  const load = (): {
    events: ReturnType<typeof loadLog>["events"];
    conflictCount: number;
    hash: string;
  } => {
    const report = loadLog(dataRepoDir);
    if (report.conflicts.length > 0) {
      warn(
        `kanon: union merge found ${report.conflicts.length} conflicting duplicate event id(s) ` +
          `(${report.conflicts.map((conflict) => conflict.id).join(", ")}); a producer is ` +
          "misbehaving — proceeding with the tie-broken canonical stream",
      );
    }
    return {
      events: report.events,
      conflictCount: report.conflicts.length,
      hash: contentHash(report.events),
    };
  };

  return {
    db,
    dir: dataRepoDir,
    refresh(): RefreshResult {
      const { events, conflictCount, hash } = load();
      const headId = events.at(-1)?.id ?? null;
      const meta = readMeta(db);
      if (
        conflictCount === 0 && // a conflicted log always rebuilds
        meta !== undefined &&
        meta.schemaVersion === PROJECTION_SCHEMA_VERSION &&
        meta.headId === headId &&
        meta.eventCount === events.length &&
        meta.contentHash === hash
      ) {
        return { rebuilt: false, eventCount: events.length, headId, conflictCount };
      }
      return rebuildFrom(events, conflictCount, hash);
    },
    rebuild(): RefreshResult {
      const { events, conflictCount, hash } = load();
      return rebuildFrom(events, conflictCount, hash);
    },
    close(): void {
      db.close();
    },
  };
}

/**
 * Content checksum over every projection table except `projection_meta`:
 * rows serialized canonically (`stableStringify`), sorted per table, FNV-1a
 * folded. Two projections hold the same content iff their checksums match —
 * the convergence probe used by rebuild-idempotence and multi-clone tests.
 */
export function projectionChecksum(db: Database): string {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "AND name != 'projection_meta' ORDER BY name",
    )
    .all();
  const parts: string[] = [];
  for (const { name } of tables) {
    const rows = db.query(`SELECT * FROM ${quoteIdent(name)}`).all() as Record<string, unknown>[];
    const serialized = rows.map((row) => stableStringify(row)).sort();
    parts.push(`${name}\n${serialized.join("\n")}`);
  }
  return fnv1a64(parts.join("\n"));
}
