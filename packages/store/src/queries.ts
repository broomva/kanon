/**
 * Read queries over the SQLite projection.
 *
 * Reference resolution is deterministic everywhere: ULID → identifier /
 * key → exact name (case-insensitive). Resolution helpers return ALL
 * matches so callers (the CLI) can error with candidates on ambiguity.
 *
 * Blocked-direction convention (verified against the Linear importer's
 * transform): a relation row `{rel_type: 'blocks', issue_id: A,
 * related_issue_id: B}` means A BLOCKS B. An issue is blocked iff a
 * non-deleted `blocks` row points AT it (`related_issue_id = issue`) from a
 * blocker whose state_type is not completed/canceled.
 */

import type { Database } from "bun:sqlite";
import { ULID_PATTERN } from "@kanon/core";

type Binding = string | number;

interface BaseRow {
  id: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted: number;
  data_json: string | null;
}

export interface BaseRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deleted: boolean;
  /** Overflow fields that have no typed column (parsed data_json). */
  data: Record<string, unknown>;
}

function baseRecord(row: BaseRow): BaseRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    deleted: row.deleted !== 0,
    data: row.data_json === null ? {} : (JSON.parse(row.data_json) as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// Models without a dedicated table (other_entities)
// ---------------------------------------------------------------------------

/**
 * Non-deleted entities of a model that has no dedicated projection table
 * (webhook, api_key, initiative, ...). All fields live in `data` (parsed
 * data_json overflow).
 */
export function listModelEntities(db: Database, model: string): BaseRecord[] {
  return db
    .query<BaseRow, [string]>(
      "SELECT * FROM other_entities WHERE deleted = 0 AND model = ? ORDER BY id",
    )
    .all(model)
    .map(baseRecord);
}

/**
 * Initiatives live in `other_entities` (no dedicated table in v1 — low volume,
 * no typed filtering), so resolve them over the parsed `data`: ULID → exact
 * name (case-insensitive), mirroring `resolveProjects`. Returns ALL matches so
 * callers can error with candidates on an ambiguous name.
 */
export function resolveInitiatives(db: Database, ref: string): BaseRecord[] {
  const all = listModelEntities(db, "initiative");
  if (ULID_PATTERN.test(ref)) {
    const byId = all.filter((rec) => rec.id === ref);
    if (byId.length > 0) return byId;
  }
  const lower = ref.toLowerCase();
  return all.filter((rec) => String(rec.data.name ?? "").toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

interface TeamRow extends BaseRow {
  key: string | null;
  name: string | null;
}

export interface TeamRecord extends BaseRecord {
  key: string | null;
  name: string | null;
}

function teamRecord(row: TeamRow): TeamRecord {
  return { ...baseRecord(row), key: row.key, name: row.name };
}

export function listTeams(db: Database): TeamRecord[] {
  const rows = db
    .query<TeamRow, []>("SELECT * FROM teams WHERE deleted = 0 ORDER BY key, id")
    .all();
  return rows.map(teamRecord);
}

/** All teams matching `ref` in deterministic order: ULID → key (ci) → name (ci). */
export function resolveTeams(db: Database, ref: string): TeamRecord[] {
  if (ULID_PATTERN.test(ref)) {
    const rows = db.query<TeamRow, [string]>("SELECT * FROM teams WHERE id = ?").all(ref);
    if (rows.length > 0) return rows.map(teamRecord);
  }
  const byKey = db
    .query<TeamRow, [string]>(
      "SELECT * FROM teams WHERE deleted = 0 AND UPPER(key) = UPPER(?) ORDER BY id",
    )
    .all(ref);
  if (byKey.length > 0) return byKey.map(teamRecord);
  return db
    .query<TeamRow, [string]>(
      "SELECT * FROM teams WHERE deleted = 0 AND name = ? COLLATE NOCASE ORDER BY id",
    )
    .all(ref)
    .map(teamRecord);
}

export function getTeam(db: Database, ref: string): TeamRecord | undefined {
  return resolveTeams(db, ref)[0];
}

// ---------------------------------------------------------------------------
// Workflow states
// ---------------------------------------------------------------------------

interface StateRow extends BaseRow {
  team_id: string | null;
  name: string | null;
  state_type: string | null;
  color: string | null;
  position: number | null;
}

export interface StateRecord extends BaseRecord {
  teamId: string | null;
  name: string | null;
  stateType: string | null;
  color: string | null;
  position: number | null;
}

function stateRecord(row: StateRow): StateRecord {
  return {
    ...baseRecord(row),
    teamId: row.team_id,
    name: row.name,
    stateType: row.state_type,
    color: row.color,
    position: row.position,
  };
}

export function listStates(db: Database, teamId?: string): StateRecord[] {
  if (teamId !== undefined) {
    return db
      .query<StateRow, [string]>(
        "SELECT * FROM workflow_states WHERE deleted = 0 AND team_id = ? ORDER BY position, id",
      )
      .all(teamId)
      .map(stateRecord);
  }
  return db
    .query<StateRow, []>("SELECT * FROM workflow_states WHERE deleted = 0 ORDER BY position, id")
    .all()
    .map(stateRecord);
}

/**
 * All states matching `ref`, optionally scoped to a team, in deterministic
 * order: ULID → name (ci) → state_type (exact, lowercased). The NAME tier
 * outranks the type tier on purpose: a user naming a specific state (e.g. a
 * state called "Backlog") must never be silently rerouted to a different
 * state that merely carries the matching TYPE (e.g. an "Icebox" of type
 * backlog). Type references still work whenever no state name shadows them.
 */
export function resolveStates(db: Database, ref: string, teamId?: string): StateRecord[] {
  const scope = teamId === undefined ? "" : " AND team_id = ?";
  const scopeParams: Binding[] = teamId === undefined ? [] : [teamId];
  if (ULID_PATTERN.test(ref)) {
    const rows = db
      .query<StateRow, Binding[]>(`SELECT * FROM workflow_states WHERE id = ?${scope}`)
      .all(ref, ...scopeParams);
    if (rows.length > 0) return rows.map(stateRecord);
  }
  const byName = db
    .query<StateRow, Binding[]>(
      `SELECT * FROM workflow_states WHERE deleted = 0 AND name = ? COLLATE NOCASE${scope} ` +
        "ORDER BY position, id",
    )
    .all(ref, ...scopeParams);
  if (byName.length > 0) return byName.map(stateRecord);
  return db
    .query<StateRow, Binding[]>(
      `SELECT * FROM workflow_states WHERE deleted = 0 AND state_type = ?${scope} ` +
        "ORDER BY position, id",
    )
    .all(ref.toLowerCase(), ...scopeParams)
    .map(stateRecord);
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

interface ActorRow extends BaseRow {
  name: string | null;
  display_name: string | null;
  email: string | null;
  actor_type: string | null;
}

export interface ActorRecord extends BaseRecord {
  name: string | null;
  displayName: string | null;
  email: string | null;
  actorType: string | null;
}

function actorRecord(row: ActorRow): ActorRecord {
  return {
    ...baseRecord(row),
    name: row.name,
    displayName: row.display_name,
    email: row.email,
    actorType: row.actor_type,
  };
}

export function listActors(db: Database): ActorRecord[] {
  return db
    .query<ActorRow, []>("SELECT * FROM actors WHERE deleted = 0 ORDER BY name, id")
    .all()
    .map(actorRecord);
}

/** All actors matching `ref`: ULID → email (ci) → name (ci) → display name (ci). */
export function resolveActors(db: Database, ref: string): ActorRecord[] {
  if (ULID_PATTERN.test(ref)) {
    const rows = db.query<ActorRow, [string]>("SELECT * FROM actors WHERE id = ?").all(ref);
    if (rows.length > 0) return rows.map(actorRecord);
  }
  for (const column of ["email", "name", "display_name"]) {
    const rows = db
      .query<ActorRow, [string]>(
        `SELECT * FROM actors WHERE deleted = 0 AND ${column} = ? COLLATE NOCASE ORDER BY id`,
      )
      .all(ref);
    if (rows.length > 0) return rows.map(actorRecord);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

interface LabelRow extends BaseRow {
  team_id: string | null;
  name: string | null;
  color: string | null;
}

export interface LabelRecord extends BaseRecord {
  teamId: string | null;
  name: string | null;
  color: string | null;
}

function labelRecord(row: LabelRow): LabelRecord {
  return { ...baseRecord(row), teamId: row.team_id, name: row.name, color: row.color };
}

export function listLabels(db: Database): LabelRecord[] {
  return db
    .query<LabelRow, []>("SELECT * FROM labels WHERE deleted = 0 ORDER BY name, id")
    .all()
    .map(labelRecord);
}

/** All labels matching `ref`: ULID → name (ci). */
export function resolveLabels(db: Database, ref: string): LabelRecord[] {
  if (ULID_PATTERN.test(ref)) {
    const rows = db.query<LabelRow, [string]>("SELECT * FROM labels WHERE id = ?").all(ref);
    if (rows.length > 0) return rows.map(labelRecord);
  }
  return db
    .query<LabelRow, [string]>(
      "SELECT * FROM labels WHERE deleted = 0 AND name = ? COLLATE NOCASE ORDER BY id",
    )
    .all(ref)
    .map(labelRecord);
}

// ---------------------------------------------------------------------------
// Projects + milestones
// ---------------------------------------------------------------------------

interface ProjectRow extends BaseRow {
  name: string | null;
  description: string | null;
  state: string | null;
  lead_id: string | null;
  target_date: string | null;
}

export interface ProjectRecord extends BaseRecord {
  name: string | null;
  description: string | null;
  state: string | null;
  leadId: string | null;
  targetDate: string | null;
}

function projectRecord(row: ProjectRow): ProjectRecord {
  return {
    ...baseRecord(row),
    name: row.name,
    description: row.description,
    state: row.state,
    leadId: row.lead_id,
    targetDate: row.target_date,
  };
}

export function listProjects(db: Database): ProjectRecord[] {
  return db
    .query<ProjectRow, []>("SELECT * FROM projects WHERE deleted = 0 ORDER BY name, id")
    .all()
    .map(projectRecord);
}

/** All projects matching `ref`: ULID → name (ci). */
export function resolveProjects(db: Database, ref: string): ProjectRecord[] {
  if (ULID_PATTERN.test(ref)) {
    const rows = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").all(ref);
    if (rows.length > 0) return rows.map(projectRecord);
  }
  return db
    .query<ProjectRow, [string]>(
      "SELECT * FROM projects WHERE deleted = 0 AND name = ? COLLATE NOCASE ORDER BY id",
    )
    .all(ref)
    .map(projectRecord);
}

interface MilestoneRow extends BaseRow {
  project_id: string | null;
  name: string | null;
  target_date: string | null;
}

export interface MilestoneRecord extends BaseRecord {
  projectId: string | null;
  name: string | null;
  targetDate: string | null;
}

function milestoneRecord(row: MilestoneRow): MilestoneRecord {
  return {
    ...baseRecord(row),
    projectId: row.project_id,
    name: row.name,
    targetDate: row.target_date,
  };
}

export function listMilestones(db: Database, projectId?: string): MilestoneRecord[] {
  if (projectId !== undefined) {
    return db
      .query<MilestoneRow, [string]>(
        "SELECT * FROM milestones WHERE deleted = 0 AND project_id = ? ORDER BY name, id",
      )
      .all(projectId)
      .map(milestoneRecord);
  }
  return db
    .query<MilestoneRow, []>("SELECT * FROM milestones WHERE deleted = 0 ORDER BY name, id")
    .all()
    .map(milestoneRecord);
}

/** All milestones matching `ref`, optionally scoped to a project: ULID → name (ci). */
export function resolveMilestones(
  db: Database,
  ref: string,
  projectId?: string,
): MilestoneRecord[] {
  const scope = projectId === undefined ? "" : " AND project_id = ?";
  const scopeParams: Binding[] = projectId === undefined ? [] : [projectId];
  if (ULID_PATTERN.test(ref)) {
    const rows = db
      .query<MilestoneRow, Binding[]>(`SELECT * FROM milestones WHERE id = ?${scope}`)
      .all(ref, ...scopeParams);
    if (rows.length > 0) return rows.map(milestoneRecord);
  }
  return db
    .query<MilestoneRow, Binding[]>(
      `SELECT * FROM milestones WHERE deleted = 0 AND name = ? COLLATE NOCASE${scope} ORDER BY id`,
    )
    .all(ref, ...scopeParams)
    .map(milestoneRecord);
}

// ---------------------------------------------------------------------------
// Comments + relations
// ---------------------------------------------------------------------------

interface CommentRow extends BaseRow {
  issue_id: string | null;
  body: string | null;
  actor_id: string | null;
  parent_id: string | null;
}

export interface CommentRecord extends BaseRecord {
  issueId: string | null;
  body: string | null;
  actorId: string | null;
  parentId: string | null;
}

function commentRecord(row: CommentRow): CommentRecord {
  return {
    ...baseRecord(row),
    issueId: row.issue_id,
    body: row.body,
    actorId: row.actor_id,
    parentId: row.parent_id,
  };
}

export function listComments(db: Database, issueId: string): CommentRecord[] {
  return db
    .query<CommentRow, [string]>(
      "SELECT * FROM comments WHERE deleted = 0 AND issue_id = ? ORDER BY created_at, id",
    )
    .all(issueId)
    .map(commentRecord);
}

/** One non-deleted comment by ULID. */
export function getComment(db: Database, id: string): CommentRecord | undefined {
  if (!ULID_PATTERN.test(id)) return undefined;
  const row = db
    .query<CommentRow, [string]>("SELECT * FROM comments WHERE deleted = 0 AND id = ?")
    .get(id);
  return row === null ? undefined : commentRecord(row);
}

interface RelationRow extends BaseRow {
  rel_type: string | null;
  issue_id: string | null;
  related_issue_id: string | null;
}

export interface RelationRecord extends BaseRecord {
  relType: string | null;
  issueId: string | null;
  relatedIssueId: string | null;
}

function relationRecord(row: RelationRow): RelationRecord {
  return {
    ...baseRecord(row),
    relType: row.rel_type,
    issueId: row.issue_id,
    relatedIssueId: row.related_issue_id,
  };
}

/**
 * The canonical key for a logical edge. `blocks` is directional (A blocks B ≠
 * B blocks A); `related` is symmetric (either stored direction is the same
 * edge). Two clones that `relate` the same edge offline mint two entities with
 * different ULIDs but the SAME canonical key — dedupe collapses them so an
 * `unrelate` (which tombstones every matching entity) actually clears the edge.
 */
export function canonicalRelationKey(
  relType: string | null,
  issueId: string | null,
  relatedIssueId: string | null,
): string {
  const a = issueId ?? "";
  const b = relatedIssueId ?? "";
  if (relType === "related") {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return `related|${lo}|${hi}`;
  }
  return `${relType ?? ""}|${a}|${b}`;
}

/**
 * Non-deleted relations touching an issue from EITHER side, deduped to one row
 * per logical edge (earliest ULID wins). Cross-clone duplicates stay in the log
 * — this is a read-side projection concern, not a core-merge change.
 */
export function listRelations(db: Database, issueId: string): RelationRecord[] {
  const rows = db
    .query<RelationRow, [string, string]>(
      "SELECT * FROM issue_relations WHERE deleted = 0 AND (issue_id = ? OR related_issue_id = ?) " +
        "ORDER BY id",
    )
    .all(issueId, issueId)
    .map(relationRecord);
  const seen = new Set<string>();
  const deduped: RelationRecord[] = [];
  for (const row of rows) {
    const key = canonicalRelationKey(row.relType, row.issueId, row.relatedIssueId);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

/**
 * Every non-deleted relation entity for one logical edge — the exact triple,
 * plus the reversed direction when `related` (symmetric). `unrelate` tombstones
 * all of them so a cross-clone duplicate can't leave the edge half-standing.
 */
export function findAllRelations(
  db: Database,
  relType: string,
  issueId: string,
  relatedIssueId: string,
): RelationRecord[] {
  const direct = db
    .query<RelationRow, [string, string, string]>(
      "SELECT * FROM issue_relations WHERE deleted = 0 AND rel_type = ? AND issue_id = ? " +
        "AND related_issue_id = ? ORDER BY id",
    )
    .all(relType, issueId, relatedIssueId)
    .map(relationRecord);
  if (relType !== "related") return direct;
  const reverse = db
    .query<RelationRow, [string, string, string]>(
      "SELECT * FROM issue_relations WHERE deleted = 0 AND rel_type = ? AND issue_id = ? " +
        "AND related_issue_id = ? ORDER BY id",
    )
    .all(relType, relatedIssueId, issueId)
    .map(relationRecord);
  return [...direct, ...reverse];
}

/** The non-deleted relation row exactly matching (rel_type, issue_id, related_issue_id). */
export function findRelation(
  db: Database,
  relType: string,
  issueId: string,
  relatedIssueId: string,
): RelationRecord | undefined {
  const row = db
    .query<RelationRow, [string, string, string]>(
      "SELECT * FROM issue_relations WHERE deleted = 0 AND rel_type = ? AND issue_id = ? " +
        "AND related_issue_id = ? ORDER BY id LIMIT 1",
    )
    .get(relType, issueId, relatedIssueId);
  return row === null ? undefined : relationRecord(row);
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

interface IssueRow extends BaseRow {
  team_id: string | null;
  number: number | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  state_id: string | null;
  priority: number | null;
  estimate: number | null;
  assignee_id: string | null;
  delegate_id: string | null;
  parent_id: string | null;
  project_id: string | null;
  milestone_id: string | null;
}

export interface IssueRecord extends BaseRecord {
  teamId: string | null;
  number: number | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  stateId: string | null;
  priority: number | null;
  estimate: number | null;
  assigneeId: string | null;
  delegateId: string | null;
  parentId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  labelIds: string[];
}

function issueRecord(db: Database, row: IssueRow): IssueRecord {
  const labels = db
    .query<{ label_id: string }, [string]>(
      "SELECT label_id FROM issue_labels WHERE issue_id = ? ORDER BY label_id",
    )
    .all(row.id);
  return {
    ...baseRecord(row),
    teamId: row.team_id,
    number: row.number,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    stateId: row.state_id,
    priority: row.priority,
    estimate: row.estimate,
    assigneeId: row.assignee_id,
    delegateId: row.delegate_id,
    parentId: row.parent_id,
    projectId: row.project_id,
    milestoneId: row.milestone_id,
    labelIds: labels.map((label) => label.label_id),
  };
}

export interface IssueFilters {
  /** Team ULID or key (case-insensitive). */
  team?: string;
  /** State ULID, state_type, or state name (deterministic resolution order). */
  state?: string;
  /** Assignee actor ULID. */
  assignee?: string;
  /** Delegate actor ULID. */
  delegate?: string;
  /** Project ULID. */
  project?: string;
  /** Label ULID or name (case-insensitive). */
  label?: string;
  priority?: number;
  parentId?: string;
  /** Inclusive bounds on updated_at (ISO-8601). */
  updatedAfter?: string;
  updatedBefore?: string;
  /** Substring match (case-insensitive LIKE) on title. */
  query?: string;
  /** Default true — archived issues are listed unless explicitly excluded. */
  includeArchived?: boolean;
  /** Default false — tombstoned issues are hidden unless requested. */
  includeDeleted?: boolean;
  orderBy?: "createdAt" | "updatedAt";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Filtered issue listing. Unresolvable team/state/label references return an
 * empty list (the store is a query layer; the CLI resolves references first
 * and reports candidates on ambiguity).
 */
export function listIssues(db: Database, filters: IssueFilters = {}): IssueRecord[] {
  const where: string[] = [];
  const params: Binding[] = [];

  if (filters.includeDeleted !== true) {
    where.push("i.deleted = 0");
  }
  if (filters.includeArchived === false) {
    where.push("i.archived_at IS NULL");
  }
  if (filters.team !== undefined) {
    const teams = resolveTeams(db, filters.team);
    if (teams.length === 0) return [];
    where.push(`i.team_id IN (${teams.map(() => "?").join(", ")})`);
    params.push(...teams.map((team) => team.id));
  }
  if (filters.state !== undefined) {
    const states = resolveStates(db, filters.state);
    if (states.length === 0) return [];
    where.push(`i.state_id IN (${states.map(() => "?").join(", ")})`);
    params.push(...states.map((state) => state.id));
  }
  if (filters.assignee !== undefined) {
    where.push("i.assignee_id = ?");
    params.push(filters.assignee);
  }
  if (filters.delegate !== undefined) {
    where.push("i.delegate_id = ?");
    params.push(filters.delegate);
  }
  if (filters.project !== undefined) {
    where.push("i.project_id = ?");
    params.push(filters.project);
  }
  if (filters.label !== undefined) {
    const labels = resolveLabels(db, filters.label);
    if (labels.length === 0) return [];
    where.push(
      "i.id IN (SELECT issue_id FROM issue_labels WHERE label_id IN " +
        `(${labels.map(() => "?").join(", ")}))`,
    );
    params.push(...labels.map((label) => label.id));
  }
  if (filters.priority !== undefined) {
    where.push("i.priority = ?");
    params.push(filters.priority);
  }
  if (filters.parentId !== undefined) {
    where.push("i.parent_id = ?");
    params.push(filters.parentId);
  }
  if (filters.updatedAfter !== undefined) {
    where.push("i.updated_at >= ?");
    params.push(filters.updatedAfter);
  }
  if (filters.updatedBefore !== undefined) {
    where.push("i.updated_at <= ?");
    params.push(filters.updatedBefore);
  }
  if (filters.query !== undefined) {
    where.push("i.title LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(filters.query)}%`);
  }

  const orderColumn = filters.orderBy === "updatedAt" ? "i.updated_at" : "i.created_at";
  const orderDir = filters.orderDir === "desc" ? "DESC" : "ASC";
  let sql = `SELECT i.* FROM issues i${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} `;
  sql += `ORDER BY ${orderColumn} ${orderDir}, i.id ${orderDir}`;
  if (filters.limit !== undefined || filters.offset !== undefined) {
    sql += " LIMIT ? OFFSET ?";
    params.push(filters.limit ?? -1, filters.offset ?? 0);
  }

  return db
    .query<IssueRow, Binding[]>(sql)
    .all(...params)
    .map((row) => issueRecord(db, row));
}

const IDENTIFIER_PATTERN = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

/**
 * Look up one issue by ULID or display identifier (TEAM-123,
 * case-insensitive). Post-merge duplicate identifiers resolve to the
 * earliest-ULID, non-deleted issue (`kanon doctor` repairs the collision).
 */
export function getIssue(db: Database, ref: string): IssueRecord | undefined {
  if (ULID_PATTERN.test(ref)) {
    const row = db.query<IssueRow, [string]>("SELECT * FROM issues WHERE id = ?").get(ref);
    return row === null ? undefined : issueRecord(db, row);
  }
  const match = IDENTIFIER_PATTERN.exec(ref);
  if (match === null) return undefined;
  const [, key, numberText] = match;
  if (key === undefined || numberText === undefined) return undefined;
  const row = db
    .query<IssueRow, [string, number]>(
      "SELECT i.* FROM issues i JOIN teams t ON t.id = i.team_id " +
        "WHERE UPPER(t.key) = UPPER(?) AND i.number = ? AND i.deleted = 0 " +
        "ORDER BY i.id LIMIT 1",
    )
    .get(key, Number(numberText));
  return row === null ? undefined : issueRecord(db, row);
}

const OPEN_READY_TYPES = "('backlog', 'unstarted')";
const CLOSED_TYPES = "('completed', 'canceled')";

/**
 * Ready work: issues in a backlog/unstarted state, alive (not deleted, not
 * archived), and not blocked. Blocked = a non-deleted `blocks` relation
 * points AT the issue (`related_issue_id = issue`) from a non-deleted
 * blocker whose state_type is not completed/canceled (a blocker with no
 * resolvable state counts as open — conservative). Deliberate semantics:
 * an ARCHIVED-but-open blocker STILL BLOCKS — archiving hides an issue,
 * it does not complete it; complete/cancel the blocker (or unrelate) to
 * unblock dependents. Ordered by priority (urgent → low, none last), then
 * created_at.
 */
export function readyIssues(db: Database, team?: string): IssueRecord[] {
  const where: string[] = [
    "i.deleted = 0",
    "i.archived_at IS NULL",
    `s.state_type IN ${OPEN_READY_TYPES}`,
  ];
  const params: Binding[] = [];
  if (team !== undefined) {
    const teams = resolveTeams(db, team);
    if (teams.length === 0) return [];
    where.push(`i.team_id IN (${teams.map(() => "?").join(", ")})`);
    params.push(...teams.map((entry) => entry.id));
  }
  where.push(
    "NOT EXISTS (" +
      "SELECT 1 FROM issue_relations r " +
      "JOIN issues b ON b.id = r.issue_id " +
      "LEFT JOIN workflow_states bs ON bs.id = b.state_id " +
      "WHERE r.deleted = 0 AND r.rel_type = 'blocks' AND r.related_issue_id = i.id " +
      "AND b.deleted = 0 " +
      `AND (bs.state_type IS NULL OR bs.state_type NOT IN ${CLOSED_TYPES})` +
      ")",
  );
  const sql =
    "SELECT i.* FROM issues i JOIN workflow_states s ON s.id = i.state_id " +
    `WHERE ${where.join(" AND ")} ` +
    "ORDER BY CASE WHEN i.priority IS NULL OR i.priority = 0 THEN 99 ELSE i.priority END, " +
    "i.created_at, i.id";
  return db
    .query<IssueRow, Binding[]>(sql)
    .all(...params)
    .map((row) => issueRecord(db, row));
}

// ---------------------------------------------------------------------------
// Agent sessions + activities
// ---------------------------------------------------------------------------

interface AgentSessionRow extends BaseRow {
  issue_id: string | null;
  actor_id: string | null;
  state: string | null;
}

export interface AgentSessionRecord extends BaseRecord {
  issueId: string | null;
  actorId: string | null;
  state: string | null;
}

function agentSessionRecord(row: AgentSessionRow): AgentSessionRecord {
  return {
    ...baseRecord(row),
    issueId: row.issue_id,
    actorId: row.actor_id,
    state: row.state,
  };
}

export interface AgentSessionFilters {
  issueId?: string;
  actorId?: string;
  state?: string;
}

/** Non-deleted agent sessions, ULID (= creation) order. */
export function listAgentSessions(
  db: Database,
  filters: AgentSessionFilters = {},
): AgentSessionRecord[] {
  const where: string[] = ["deleted = 0"];
  const params: Binding[] = [];
  if (filters.issueId !== undefined) {
    where.push("issue_id = ?");
    params.push(filters.issueId);
  }
  if (filters.actorId !== undefined) {
    where.push("actor_id = ?");
    params.push(filters.actorId);
  }
  if (filters.state !== undefined) {
    where.push("state = ?");
    params.push(filters.state);
  }
  return db
    .query<AgentSessionRow, Binding[]>(
      `SELECT * FROM agent_sessions WHERE ${where.join(" AND ")} ORDER BY id`,
    )
    .all(...params)
    .map(agentSessionRecord);
}

/** One agent session by ULID (sessions have no display identifier). */
export function getAgentSession(db: Database, id: string): AgentSessionRecord | undefined {
  if (!ULID_PATTERN.test(id)) return undefined;
  const row = db
    .query<AgentSessionRow, [string]>("SELECT * FROM agent_sessions WHERE id = ?")
    .get(id);
  return row === null ? undefined : agentSessionRecord(row);
}

interface AgentActivityRow extends BaseRow {
  session_id: string | null;
  activity_type: string | null;
  body: string | null;
}

export interface AgentActivityRecord extends BaseRecord {
  sessionId: string | null;
  /** One of AGENT_ACTIVITY_TYPES (free text in the row; writers validate). */
  type: string | null;
  body: string | null;
}

/** A session's non-deleted activities, ULID (= creation) order — the timeline. */
export function listAgentActivities(db: Database, sessionId: string): AgentActivityRecord[] {
  return db
    .query<AgentActivityRow, [string]>(
      "SELECT * FROM agent_activities WHERE deleted = 0 AND session_id = ? ORDER BY id",
    )
    .all(sessionId)
    .map((row) => ({
      ...baseRecord(row),
      sessionId: row.session_id,
      type: row.activity_type,
      body: row.body,
    }));
}
