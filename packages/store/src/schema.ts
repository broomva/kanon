/**
 * Projection schema — typed columns per model plus a `data_json` overflow
 * column, so fields the projection does not know about (importer provenance
 * like `linearId`, future schema additions) survive a round-trip through
 * SQLite instead of being silently dropped.
 *
 * Every table carries the replay bookkeeping columns (`created_at`,
 * `updated_at`, `archived_at`, `deleted`) derived from the core `Entity`.
 * Models without a dedicated table land in `other_entities` keyed by
 * `(model, id)` — the projection is a cache of the WHOLE log, not a filter.
 *
 * Bump `PROJECTION_SCHEMA_VERSION` on any DDL or mapping change: `refresh()`
 * treats a version mismatch like a log mismatch and rebuilds from genesis.
 */

import type { Model } from "@kanon/core";

/** Bump on any DDL/mapping change — forces a rebuild of existing caches. */
// v2: issue_labels is derived from issue_label edge entities (OR-Set) unioned
// with the legacy whole-array labelIds field, not the array alone (BRO-1678).
export const PROJECTION_SCHEMA_VERSION = 2;

export type ColumnKind = "text" | "number";

export interface ColumnSpec {
  /** SQLite column name (snake_case). */
  column: string;
  /** Entity field name in event data (camelCase). */
  field: string;
  kind: ColumnKind;
}

export interface TableSpec {
  table: string;
  columns: ColumnSpec[];
}

const text = (column: string, field: string): ColumnSpec => ({ column, field, kind: "text" });
const num = (column: string, field: string): ColumnSpec => ({ column, field, kind: "number" });

/** Models with a dedicated table. Everything else goes to `other_entities`. */
export const MODEL_TABLES: Partial<Record<Model, TableSpec>> = {
  workspace: {
    table: "workspaces",
    columns: [text("slug", "slug"), text("name", "name")],
  },
  team: {
    table: "teams",
    columns: [text("key", "key"), text("name", "name")],
  },
  actor: {
    table: "actors",
    columns: [
      text("name", "name"),
      text("display_name", "displayName"),
      text("email", "email"),
      text("actor_type", "actorType"),
    ],
  },
  workflow_state: {
    table: "workflow_states",
    columns: [
      text("team_id", "teamId"),
      text("name", "name"),
      text("state_type", "type"),
      text("color", "color"),
      num("position", "position"),
    ],
  },
  issue: {
    table: "issues",
    columns: [
      text("team_id", "teamId"),
      num("number", "number"),
      text("title", "title"),
      text("description", "description"),
      text("state_id", "stateId"),
      num("priority", "priority"),
      num("estimate", "estimate"),
      text("assignee_id", "assigneeId"),
      text("delegate_id", "delegateId"),
      text("parent_id", "parentId"),
      text("project_id", "projectId"),
      text("milestone_id", "milestoneId"),
    ],
  },
  label: {
    table: "labels",
    columns: [text("team_id", "teamId"), text("name", "name"), text("color", "color")],
  },
  project: {
    table: "projects",
    columns: [
      text("name", "name"),
      text("description", "description"),
      text("state", "state"),
      text("lead_id", "leadId"),
      text("target_date", "targetDate"),
    ],
  },
  milestone: {
    table: "milestones",
    columns: [
      text("project_id", "projectId"),
      text("name", "name"),
      text("target_date", "targetDate"),
    ],
  },
  comment: {
    table: "comments",
    columns: [
      text("issue_id", "issueId"),
      text("body", "body"),
      text("actor_id", "actorId"),
      text("parent_id", "parentId"),
    ],
  },
  issue_relation: {
    table: "issue_relations",
    columns: [
      text("rel_type", "type"),
      text("issue_id", "issueId"),
      text("related_issue_id", "relatedIssueId"),
    ],
  },
  agent_session: {
    table: "agent_sessions",
    columns: [text("issue_id", "issueId"), text("actor_id", "actorId"), text("state", "state")],
  },
  agent_activity: {
    table: "agent_activities",
    columns: [text("session_id", "sessionId"), text("activity_type", "type"), text("body", "body")],
  },
};

const BOOKKEEPING_COLUMNS =
  "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, " +
  "deleted INTEGER NOT NULL, data_json TEXT";

function columnDdl(spec: ColumnSpec): string {
  return `${spec.column} ${spec.kind === "text" ? "TEXT" : "NUMERIC"}`;
}

/** Full DDL for the projection, in creation order. */
export function schemaDdl(): string[] {
  const statements: string[] = [
    "CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ];
  for (const spec of Object.values(MODEL_TABLES)) {
    const typed = spec.columns.map(columnDdl).join(", ");
    const identifier = spec.table === "issues" ? "identifier TEXT, " : "";
    statements.push(
      `CREATE TABLE ${spec.table} (id TEXT PRIMARY KEY, ${typed}, ${identifier}${BOOKKEEPING_COLUMNS})`,
    );
  }
  statements.push(
    "CREATE TABLE issue_labels (issue_id TEXT NOT NULL, label_id TEXT NOT NULL, " +
      "PRIMARY KEY (issue_id, label_id))",
    "CREATE TABLE other_entities (model TEXT NOT NULL, id TEXT NOT NULL, " +
      `${BOOKKEEPING_COLUMNS}, PRIMARY KEY (model, id))`,
    "CREATE INDEX idx_issues_state ON issues(state_id)",
    "CREATE INDEX idx_issues_team_number ON issues(team_id, number)",
    "CREATE INDEX idx_issues_updated ON issues(updated_at)",
    "CREATE INDEX idx_issue_relations_related ON issue_relations(related_issue_id)",
  );
  return statements;
}
