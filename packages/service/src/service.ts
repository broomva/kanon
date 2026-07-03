/**
 * The ONE service funnel — every route (ingest, domain writes, feed, SSE,
 * webhooks) goes through this module: validation → event creation →
 * appendEvents → git commit (+push) → projection refresh → bus broadcast.
 *
 * Binding contracts inherited from @kanon/core + @kanon/store:
 *   - the event log is canonical and git-carried; every store is disposable
 *     and rebuilt from the log;
 *   - ULID is the only order; segments are routing, never immutable;
 *   - append is appendFileSync-only (O_APPEND — durable before git runs);
 *   - load via unionMergeWithReport; any conflict → rebuild + warn
 *     (the store's refresh() content-hash already forces the rebuild);
 *   - display allocation = meta.json lock + max(watermark, projection max)+1;
 *   - SQLite: busy_timeout=5000 + BEGIN IMMEDIATE (already in @kanon/store).
 *
 * The server OWNS its data-repo clone: all in-process writes flow through
 * here, so the in-memory canonical stream (`log` + `knownIds`) is kept
 * exact — it only moves via reload(), which re-merges the segments after
 * every append and every pull.
 */

import {
  createEvent,
  type EventActor,
  type KanonEvent,
  MODELS,
  type Model,
  type Op,
  ULID_PATTERN,
  ulid,
  validateEvent,
} from "@kanon/core";
import {
  allocateDisplayNumber,
  appendEvents,
  type CommentRecord,
  DEFAULT_STATES,
  findRelation,
  getIssue,
  type IssueFilters,
  type IssueRecord,
  listComments,
  listIssues,
  listModelEntities,
  listProjects,
  listRelations,
  listStates,
  listTeams,
  loadLog,
  openProjection,
  type Projection,
  type ProjectRecord,
  type RelationRecord,
  readDataRepoMeta,
  readyIssues,
  resolveActors,
  resolveLabels,
  resolveMilestones,
  resolveProjects,
  resolveStates,
  resolveTeams,
  type StateRecord,
  TEAM_KEY_PATTERN,
  type TeamRecord,
  withMetaLock,
} from "@kanon/store";
import { EventBus } from "./bus";
import { commitLog, isGitRepo, pullRebaseLog, pushLog } from "./git";

/** A request-mappable error: the app layer renders `{error}` with `status`. */
export class ServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export interface EventInput {
  op: Op;
  model: Model;
  modelId?: string;
  data: Record<string, unknown>;
}

export interface FeedPage {
  events: KanonEvent[];
  head: string | null;
  hasMore: boolean;
}

export interface WebhookRecord {
  id: string;
  url: string;
  resourceTypes: string[];
  createdAt: string;
}

/** Internal delivery view — includes the secret. Never serialized to clients. */
export interface WebhookDeliveryTarget extends WebhookRecord {
  secret: string;
}

export interface ServiceOptions {
  dataDir: string;
  gitRemoteSync: boolean;
  onWarn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Body/param validation helpers — every route body funnels through these.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBody(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw new ServiceError(400, "body must be a JSON object");
  }
  return raw;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ServiceError(400, `${field} must be a string`);
  return value;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = optionalString(body, field);
  if (value === undefined || value.length === 0) {
    throw new ServiceError(400, `${field} is required (non-empty string)`);
  }
  return value;
}

function optionalInt(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError(400, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ServiceError(400, `${field} must be a finite number`);
  }
  return value;
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ServiceError(400, `${field} must be an array of strings`);
  }
  return value as string[];
}

/** Drop undefined values so event data stays JSON-safe and compact. */
function compact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function describeCandidates(candidates: { id: string; name?: string | null }[]): string {
  return candidates
    .map((candidate) => `${candidate.id}${candidate.name ? ` (${candidate.name})` : ""}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class KanonService {
  readonly dataDir: string;
  readonly workspace: string;
  readonly bus: EventBus;
  readonly projection: Projection;
  private readonly gitRemoteSync: boolean;
  private readonly warn: (message: string) => void;
  /** The merged canonical stream, ULID-ascending — moved only by reload(). */
  private log: KanonEvent[] = [];
  private knownIds = new Set<string>();

  constructor(options: ServiceOptions) {
    this.dataDir = options.dataDir;
    this.gitRemoteSync = options.gitRemoteSync;
    this.warn = options.onWarn ?? ((message) => console.warn(message));
    this.bus = new EventBus(this.warn);
    try {
      this.workspace = readDataRepoMeta(this.dataDir).workspace;
    } catch (error) {
      throw new Error(
        `KANON_DATA_DIR is not a kanon data repo (meta.json unreadable): ${this.dataDir} ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!isGitRepo(this.dataDir)) {
      throw new Error(
        `KANON_DATA_DIR is not a git repository: ${this.dataDir} — the log is git-carried; ` +
          "clone the workspace data repo (or `kanon init`) first",
      );
    }
    this.projection = openProjection(this.dataDir, {
      onWarn: (message) => this.warn(`kanon-server: ${message}`),
    });
    this.reload(false); // boot: existing history is not "new" — no broadcast
  }

  get db() {
    return this.projection.db;
  }

  head(): string | null {
    return this.log.at(-1)?.id ?? null;
  }

  eventCount(): number {
    return this.log.length;
  }

  close(): void {
    this.projection.close();
  }

  // -- canonical stream maintenance -----------------------------------------

  /**
   * Re-merge the segments, refresh the projection, and (optionally)
   * broadcast every event not seen before — the single path by which the
   * in-memory stream moves, for both in-process appends and periodic pulls.
   */
  private reload(broadcast: boolean): KanonEvent[] {
    const report = loadLog(this.dataDir);
    if (report.conflicts.length > 0) {
      this.warn(
        `kanon-server: union merge found ${report.conflicts.length} conflicting duplicate ` +
          "event id(s) — a producer is misbehaving; proceeding with the tie-broken canonical " +
          "stream (the projection rebuilds)",
      );
    }
    const fresh = report.events.filter((event) => !this.knownIds.has(event.id));
    this.log = report.events;
    this.knownIds = new Set(report.events.map((event) => event.id));
    try {
      this.projection.refresh();
    } catch (error) {
      // The append is already durable in the log; the cache rebuilds on the
      // next refresh (or delete state.db). Failing the request here would
      // make retrying clients double-create.
      this.warn(
        "kanon-server: projection refresh failed after a durable append — the write IS in " +
          `the event log; the cache rebuilds on the next refresh (${
            error instanceof Error ? error.message : String(error)
          })`,
      );
    }
    if (broadcast) {
      for (const event of fresh) {
        this.bus.emit(event);
      }
    }
    return fresh;
  }

  private commitAndPush(message: string): void {
    const commit = commitLog(this.dataDir, message);
    if (!commit.ok) this.warn(`kanon-server: ${commit.detail}`);
    if (this.gitRemoteSync) {
      const push = pushLog(this.dataDir);
      if (!push.ok) this.warn(`kanon-server: ${push.detail}`);
    }
  }

  /** Startup + every KANON_SYNC_INTERVAL: pull --rebase, refresh, broadcast. */
  syncWithRemote(): void {
    if (this.gitRemoteSync) {
      const pull = pullRebaseLog(this.dataDir);
      if (!pull.ok) this.warn(`kanon-server: ${pull.detail}`);
    }
    this.reload(true);
  }

  // -- ingest + feed ---------------------------------------------------------

  /**
   * POST /v1/events — pre-built events from a client replica. All-or-nothing
   * per request: one invalid/duplicate/foreign event rejects the batch, and
   * an accepted batch lands as one git commit.
   */
  ingest(raw: unknown): { appended: number; head: string | null } {
    const body = requireBody(raw);
    const batch = body.events;
    if (!Array.isArray(batch) || batch.length === 0) {
      throw new ServiceError(400, "body must be {events: KanonEvent[]} with at least one event");
    }
    const seen = new Set<string>();
    const events: KanonEvent[] = [];
    for (const [index, item] of batch.entries()) {
      const result = validateEvent(item);
      if (!result.ok) {
        throw new ServiceError(400, `events[${index}] invalid: ${result.errors.join("; ")}`);
      }
      const event = item as KanonEvent;
      if (event.workspace !== this.workspace) {
        throw new ServiceError(
          422,
          `events[${index}] workspace "${event.workspace}" does not match this server's workspace`,
        );
      }
      if (this.knownIds.has(event.id) || seen.has(event.id)) {
        throw new ServiceError(
          409,
          `events[${index}] duplicate id ${event.id} — event ids must be fresh`,
        );
      }
      seen.add(event.id);
      events.push(event);
    }
    appendEvents(this.dataDir, events);
    this.commitAndPush(`kanon ingest ${events.length} event(s)`);
    this.reload(true);
    return { appended: events.length, head: this.head() };
  }

  /** GET /v1/sync/events — the durable feed, strictly after the cursor. */
  feed(afterRaw: string | undefined, limitRaw: string | undefined): FeedPage {
    if (afterRaw !== undefined && !ULID_PATTERN.test(afterRaw)) {
      throw new ServiceError(400, "after must be a 26-char ULID event id");
    }
    let limit = 100;
    if (limitRaw !== undefined) {
      const value = Number(limitRaw);
      if (!Number.isInteger(value) || value < 1 || value > 1000) {
        throw new ServiceError(400, "limit must be an integer between 1 and 1000");
      }
      limit = value;
    }
    let start = 0;
    if (afterRaw !== undefined) {
      // First index with id > after (the log is ULID-ascending and deduped).
      let lo = 0;
      let hi = this.log.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const event = this.log[mid];
        if (event !== undefined && event.id <= afterRaw) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      start = lo;
    }
    return {
      events: this.log.slice(start, start + limit),
      head: this.head(),
      hasMore: start + limit < this.log.length,
    };
  }

  // -- shared write path -----------------------------------------------------

  private buildEvents(actor: EventActor, inputs: EventInput[]): KanonEvent[] {
    return inputs.map((input) =>
      createEvent({
        workspace: this.workspace,
        actor,
        op: input.op,
        model: input.model,
        modelId: input.modelId ?? ulid(),
        data: input.data,
      }),
    );
  }

  /** Build server-attributed events, append, commit(+push), broadcast. */
  private appendAsActor(actor: EventActor, inputs: EventInput[], message: string): KanonEvent[] {
    const events = this.buildEvents(actor, inputs);
    appendEvents(this.dataDir, events);
    this.commitAndPush(message);
    this.reload(true);
    return events;
  }

  /**
   * The number-allocating write path: under the meta.json lock, allocate the
   * next display number, build the events it parameterizes, and append —
   * commit/push/broadcast outside the lock. Resolve every reference BEFORE
   * calling this: a failure inside would still have advanced the watermark.
   */
  private allocateAndAppend(
    actor: EventActor,
    teamId: string,
    teamKey: string,
    inputsFor: (allocated: number) => EventInput[],
    message: string,
  ): { number: number; events: KanonEvent[] } {
    const result = withMetaLock(this.dataDir, () => {
      const number = allocateDisplayNumber(this.dataDir, this.projection.db, teamId, teamKey);
      const events = this.buildEvents(actor, inputsFor(number));
      appendEvents(this.dataDir, events);
      return { number, events };
    });
    this.commitAndPush(message);
    this.reload(true);
    return result;
  }

  // -- reference resolution (deterministic; ambiguity lists candidates) ------

  private requireTeamRef(ref: string): TeamRecord {
    const matches = resolveTeams(this.db, ref);
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    if (matches.length === 0) {
      const known = listTeams(this.db)
        .map((team) => team.key ?? team.id)
        .join(", ");
      throw new ServiceError(
        400,
        `no team matching "${ref}"${known ? ` — known teams: ${known}` : ""}`,
      );
    }
    throw new ServiceError(
      400,
      `ambiguous team "${ref}" — candidates: ${describeCandidates(matches)}`,
    );
  }

  private requireStateRef(ref: string, teamId: string): StateRecord {
    const matches = resolveStates(this.db, ref, teamId);
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    if (matches.length === 0) {
      const known = listStates(this.db, teamId)
        .map((state) => `${state.name} (${state.stateType})`)
        .join(", ");
      throw new ServiceError(
        400,
        `no state matching "${ref}"${known ? ` — team states: ${known}` : ""}`,
      );
    }
    throw new ServiceError(
      400,
      `ambiguous state "${ref}" — candidates: ${matches
        .map((state) => `${state.name} (${state.stateType})`)
        .join(", ")} — use the exact name or ULID`,
    );
  }

  private requireIssueRef(ref: string, status: 400 | 404): IssueRecord {
    const issue = getIssue(this.db, ref);
    if (issue === undefined) {
      throw new ServiceError(
        status,
        `no issue matching "${ref}" (expected a ULID or TEAM-123 identifier)`,
      );
    }
    return issue;
  }

  private requireProjectRef(ref: string): ProjectRecord {
    const matches = resolveProjects(this.db, ref);
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    if (matches.length === 0) throw new ServiceError(400, `no project matching "${ref}"`);
    throw new ServiceError(
      400,
      `ambiguous project "${ref}" — candidates: ${describeCandidates(matches)}`,
    );
  }

  /**
   * Resolve an actor reference (ULID → email → name → display name) for the
   * assignee/delegate seat, MINTING an actor entity when nothing matches —
   * agents can be delegated work before they ever touch the tracker (the
   * dispatch-server use case). Ambiguity is a 400 with candidates.
   */
  private actorRefEntity(ref: string, seat: "assignee" | "delegate", mints: EventInput[]): string {
    const matches = resolveActors(this.db, ref);
    const first = matches[0];
    if (matches.length === 1 && first !== undefined) return first.id;
    if (matches.length > 1) {
      throw new ServiceError(
        400,
        `ambiguous ${seat} "${ref}" — candidates: ${describeCandidates(matches)}`,
      );
    }
    const id = ulid();
    mints.push({
      op: "create",
      model: "actor",
      modelId: id,
      data: compact({
        name: ref,
        actorType: seat === "delegate" ? "agent" : "human",
        email: ref.includes("@") ? ref : undefined,
      }),
    });
    return id;
  }

  /**
   * The AUTHENTICATED actor as an actor ENTITY id — resolved when one
   * exists, minted otherwise (comments and claims reference actor ULIDs).
   */
  private authedActorEntity(actor: EventActor): { id: string; mint?: EventInput } {
    const matches = resolveActors(this.db, actor.id);
    const first = matches[0];
    if (matches.length === 1 && first !== undefined) return { id: first.id };
    if (matches.length > 1) {
      throw new ServiceError(
        409,
        `API key actorId "${actor.id}" matches ${matches.length} actor entities — ` +
          `configure the key with one ULID of: ${matches.map((match) => match.id).join(", ")}`,
      );
    }
    const id = ulid();
    return {
      id,
      mint: {
        op: "create",
        model: "actor",
        modelId: id,
        data: compact({
          name: actor.id,
          actorType: actor.type,
          email: actor.id.includes("@") ? actor.id : undefined,
        }),
      },
    };
  }

  /** Resolve/mint one label (team-scoped); `pending` dedupes within a write. */
  private labelEntity(
    teamId: string | null,
    ref: string,
    mints: EventInput[],
    pending: Map<string, string>,
  ): string {
    const matches = resolveLabels(this.db, ref);
    if (matches.length > 1) {
      throw new ServiceError(
        400,
        `ambiguous label "${ref}" — candidates: ${describeCandidates(matches)}`,
      );
    }
    const existing = matches[0];
    if (existing !== undefined) return existing.id;
    const key = ref.toLowerCase();
    const pendingId = pending.get(key);
    if (pendingId !== undefined) return pendingId;
    const id = ulid();
    pending.set(key, id);
    mints.push({
      op: "create",
      model: "label",
      modelId: id,
      data: compact({ name: ref, teamId: teamId ?? undefined }),
    });
    return id;
  }

  /** Default state for new issues: backlog → unstarted → lowest position. */
  private defaultStateId(teamId: string): string | undefined {
    const states = listStates(this.db, teamId);
    const byType = (type: string) => states.find((state) => state.stateType === type);
    return (byType("backlog") ?? byType("unstarted") ?? states[0])?.id;
  }

  // -- teams / projects --------------------------------------------------------

  listTeams(): TeamRecord[] {
    return listTeams(this.db);
  }

  createTeam(actor: EventActor, raw: unknown): { team: TeamRecord | null; states: StateRecord[] } {
    const body = requireBody(raw);
    const key = requireString(body, "key");
    const name = requireString(body, "name");
    if (!TEAM_KEY_PATTERN.test(key)) {
      throw new ServiceError(
        400,
        `key must be a letter followed by letters/digits (${TEAM_KEY_PATTERN}) — got "${key}"`,
      );
    }
    const existing = resolveTeams(this.db, key);
    if (existing.length > 0) {
      throw new ServiceError(409, `team key "${key}" already exists (${existing[0]?.id})`);
    }
    const teamId = ulid();
    this.appendAsActor(
      actor,
      [
        { op: "create", model: "team", modelId: teamId, data: { key, name } },
        ...DEFAULT_STATES.map(
          (state): EventInput => ({
            op: "create",
            model: "workflow_state",
            data: {
              teamId,
              name: state.name,
              type: state.type,
              color: state.color,
              position: state.position,
            },
          }),
        ),
      ],
      `kanon team create ${key}`,
    );
    const team = resolveTeams(this.db, teamId)[0] ?? null;
    return { team, states: listStates(this.db, teamId) };
  }

  listProjects(): ProjectRecord[] {
    return listProjects(this.db);
  }

  createProject(actor: EventActor, raw: unknown): ProjectRecord | null {
    const body = requireBody(raw);
    const name = requireString(body, "name");
    if (resolveProjects(this.db, name).length > 0) {
      throw new ServiceError(409, `a project named "${name}" already exists`);
    }
    const projectId = ulid();
    this.appendAsActor(
      actor,
      [
        {
          op: "create",
          model: "project",
          modelId: projectId,
          data: compact({
            name,
            description: optionalString(body, "description"),
            targetDate: optionalString(body, "targetDate"),
          }),
        },
      ],
      `kanon project create ${name}`,
    );
    return resolveProjects(this.db, projectId)[0] ?? null;
  }

  // -- issues -------------------------------------------------------------------

  /** GET /v1/issues — filters mirror @kanon/store's IssueFilters. */
  issues(query: Record<string, string | undefined>): IssueRecord[] {
    const orderBy = query.orderBy;
    if (orderBy !== undefined && orderBy !== "createdAt" && orderBy !== "updatedAt") {
      throw new ServiceError(400, "orderBy must be createdAt or updatedAt");
    }
    const orderDir = query.orderDir;
    if (orderDir !== undefined && orderDir !== "asc" && orderDir !== "desc") {
      throw new ServiceError(400, "orderDir must be asc or desc");
    }
    const intParam = (name: string, min: number, max: number): number | undefined => {
      const raw = query[name];
      if (raw === undefined) return undefined;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new ServiceError(400, `${name} must be an integer between ${min} and ${max}`);
      }
      return value;
    };
    const requireActorId = (name: "assignee" | "delegate"): string | undefined => {
      const ref = query[name];
      if (ref === undefined) return undefined;
      const matches = resolveActors(this.db, ref);
      const first = matches[0];
      if (matches.length === 1 && first !== undefined) return first.id;
      if (matches.length === 0) throw new ServiceError(400, `no actor matching "${ref}"`);
      throw new ServiceError(
        400,
        `ambiguous ${name} "${ref}" — candidates: ${describeCandidates(matches)}`,
      );
    };
    const priority = intParam("priority", 0, 4);
    const limit = intParam("limit", 1, 1_000_000);
    const offset = intParam("offset", 0, 1_000_000_000);
    const assignee = requireActorId("assignee");
    const delegate = requireActorId("delegate");
    const project =
      query.project === undefined ? undefined : this.requireProjectRef(query.project).id;
    const parentId =
      query.parent === undefined ? undefined : this.requireIssueRef(query.parent, 400).id;
    const includeArchived =
      query.includeArchived === "false" || query.includeArchived === "0" ? false : undefined;
    const filters: IssueFilters = {
      ...(query.team !== undefined && { team: query.team }),
      ...(query.state !== undefined && { state: query.state }),
      ...(assignee !== undefined && { assignee }),
      ...(delegate !== undefined && { delegate }),
      ...(project !== undefined && { project }),
      ...(query.label !== undefined && { label: query.label }),
      ...(priority !== undefined && { priority }),
      ...(parentId !== undefined && { parentId }),
      ...(query.updatedAfter !== undefined && { updatedAfter: query.updatedAfter }),
      ...(query.updatedBefore !== undefined && { updatedBefore: query.updatedBefore }),
      ...(query.query !== undefined && { query: query.query }),
      ...(includeArchived !== undefined && { includeArchived }),
      ...(orderBy !== undefined && { orderBy }),
      ...(orderDir !== undefined && { orderDir }),
      ...(limit !== undefined && { limit }),
      ...(offset !== undefined && { offset }),
    };
    return listIssues(this.db, filters);
  }

  ready(teamRef: string | undefined): IssueRecord[] {
    if (teamRef === undefined) return readyIssues(this.db);
    return readyIssues(this.db, this.requireTeamRef(teamRef).id);
  }

  private identifierOf(issueId: string | null): string | null {
    if (issueId === null) return null;
    return getIssue(this.db, issueId)?.identifier ?? issueId;
  }

  /** GET /v1/issues/:ref — issue + state + comments + relations. */
  issueDetail(ref: string): {
    issue: IssueRecord;
    state: StateRecord | null;
    comments: CommentRecord[];
    relations: (RelationRecord & {
      issueIdentifier: string | null;
      relatedIssueIdentifier: string | null;
    })[];
  } {
    const issue = this.requireIssueRef(ref, 404);
    const state =
      issue.stateId === null ? null : (resolveStates(this.db, issue.stateId)[0] ?? null);
    const comments = listComments(this.db, issue.id);
    const relations = listRelations(this.db, issue.id).map((relation) => ({
      ...relation,
      issueIdentifier: this.identifierOf(relation.issueId),
      relatedIssueIdentifier: this.identifierOf(relation.relatedIssueId),
    }));
    return { issue, state, comments, relations };
  }

  /** POST /v1/issues — allocates the display number under the meta lock. */
  createIssue(
    actor: EventActor,
    raw: unknown,
  ): { id: string; identifier: string; number: number; issue: IssueRecord | null } {
    const body = requireBody(raw);
    const team = this.requireTeamRef(requireString(body, "team"));
    const title = requireString(body, "title");
    const teamKey = team.key;
    if (teamKey === null) {
      throw new ServiceError(422, `team ${team.id} has no key — cannot allocate a display number`);
    }
    // Resolve EVERY reference BEFORE allocating: a failure past allocation
    // would still have advanced the meta.json watermark and burned a number.
    const description = optionalString(body, "description");
    const priority = optionalInt(body, "priority", 0, 4);
    const estimate = optionalNumber(body, "estimate");
    const projectRef = optionalString(body, "project");
    const project = projectRef === undefined ? undefined : this.requireProjectRef(projectRef);
    const milestoneRef = optionalString(body, "milestone");
    let milestoneId: string | undefined;
    if (milestoneRef !== undefined) {
      const matches = resolveMilestones(this.db, milestoneRef, project?.id);
      const first = matches[0];
      if (matches.length === 1 && first !== undefined) {
        milestoneId = first.id;
      } else if (matches.length === 0) {
        throw new ServiceError(400, `no milestone matching "${milestoneRef}"`);
      } else {
        throw new ServiceError(
          400,
          `ambiguous milestone "${milestoneRef}" — candidates: ${describeCandidates(matches)}`,
        );
      }
    }
    const parentRef = optionalString(body, "parent");
    const parentId = parentRef === undefined ? undefined : this.requireIssueRef(parentRef, 400).id;
    const mints: EventInput[] = [];
    const assigneeRef = optionalString(body, "assignee");
    const assigneeId =
      assigneeRef === undefined ? undefined : this.actorRefEntity(assigneeRef, "assignee", mints);
    const delegateRef = optionalString(body, "delegate");
    const delegateId =
      delegateRef === undefined ? undefined : this.actorRefEntity(delegateRef, "delegate", mints);
    const stateRef = optionalString(body, "state");
    const stateId =
      stateRef === undefined
        ? this.defaultStateId(team.id)
        : this.requireStateRef(stateRef, team.id).id;
    const pending = new Map<string, string>();
    const labelIds = [
      ...new Set(
        (optionalStringArray(body, "labels") ?? []).map((labelRef) =>
          this.labelEntity(team.id, labelRef, mints, pending),
        ),
      ),
    ];

    const issueId = ulid();
    const { number } = this.allocateAndAppend(
      actor,
      team.id,
      teamKey,
      (allocated) => [
        ...mints,
        {
          op: "create",
          model: "issue",
          modelId: issueId,
          data: compact({
            teamId: team.id,
            number: allocated,
            title,
            description,
            priority,
            estimate,
            stateId,
            assigneeId,
            delegateId,
            parentId,
            projectId: project?.id,
            milestoneId,
            labelIds: labelIds.length > 0 ? labelIds : undefined,
          }),
        },
      ],
      `kanon issue create ${teamKey}`,
    );
    return {
      id: issueId,
      identifier: `${teamKey}-${number}`,
      number,
      issue: getIssue(this.db, issueId) ?? null,
    };
  }

  /** PATCH /v1/issues/:ref — per-field LWW update event. */
  updateIssue(actor: EventActor, ref: string, raw: unknown): IssueRecord | null {
    const body = requireBody(raw);
    const issue = this.requireIssueRef(ref, 404);
    const mints: EventInput[] = [];

    const stateRef = optionalString(body, "state");
    const stateId =
      stateRef === undefined ? undefined : this.requireStateRef(stateRef, issue.teamId ?? "").id;
    const assigneeRef = optionalString(body, "assignee");
    const assigneeId =
      assigneeRef === undefined ? undefined : this.actorRefEntity(assigneeRef, "assignee", mints);
    const delegateRef = optionalString(body, "delegate");
    const delegateId =
      delegateRef === undefined ? undefined : this.actorRefEntity(delegateRef, "delegate", mints);

    let labelIds: string[] | undefined;
    const replaceLabels = optionalStringArray(body, "labels");
    const addLabels = optionalStringArray(body, "addLabels") ?? [];
    const removeLabels = optionalStringArray(body, "removeLabels") ?? [];
    if (replaceLabels !== undefined || addLabels.length > 0 || removeLabels.length > 0) {
      const pending = new Map<string, string>();
      const next = new Set(
        replaceLabels === undefined
          ? issue.labelIds
          : replaceLabels.map((labelRef) =>
              this.labelEntity(issue.teamId, labelRef, mints, pending),
            ),
      );
      for (const labelRef of addLabels) {
        next.add(this.labelEntity(issue.teamId, labelRef, mints, pending));
      }
      for (const labelRef of removeLabels) {
        const matches = resolveLabels(this.db, labelRef);
        const label = matches[0];
        if (label === undefined || matches.length > 1 || !next.delete(label.id)) {
          throw new ServiceError(
            400,
            `${issue.identifier ?? issue.id} does not carry label "${labelRef}"`,
          );
        }
      }
      labelIds = [...next].sort();
    }

    const data = compact({
      stateId,
      title: optionalString(body, "title"),
      description: optionalString(body, "description"),
      priority: optionalInt(body, "priority", 0, 4),
      estimate: optionalNumber(body, "estimate"),
      assigneeId,
      delegateId,
      labelIds,
    });
    if (Object.keys(data).length === 0) {
      throw new ServiceError(400, "update requires at least one field");
    }
    this.appendAsActor(
      actor,
      [...mints, { op: "update", model: "issue", modelId: issue.id, data }],
      `kanon issue update ${issue.identifier ?? issue.id}`,
    );
    return getIssue(this.db, issue.id) ?? null;
  }

  /** POST /v1/issues/:ref/comments — actor entity minted on first use. */
  comment(
    actor: EventActor,
    ref: string,
    raw: unknown,
  ): { id: string; issueId: string; body: string; actorId: string } {
    const body = requireBody(raw);
    const issue = this.requireIssueRef(ref, 404);
    const text = requireString(body, "body");
    const { id: actorId, mint } = this.authedActorEntity(actor);
    const commentId = ulid();
    this.appendAsActor(
      actor,
      [
        ...(mint === undefined ? [] : [mint]),
        {
          op: "create",
          model: "comment",
          modelId: commentId,
          data: { issueId: issue.id, body: text, actorId },
        },
      ],
      `kanon issue comment ${issue.identifier ?? issue.id}`,
    );
    return { id: commentId, issueId: issue.id, body: text, actorId };
  }

  /**
   * POST /v1/issues/:ref/relations {type, target}. Direction convention
   * (matches the CLI + Linear importer): `{blocks, issue_id: A,
   * related_issue_id: B}` means A BLOCKS B; `blocked-by` flips it; `related`
   * is symmetric.
   */
  relate(
    actor: EventActor,
    ref: string,
    raw: unknown,
  ): {
    created: boolean;
    relation: { id: string; type: string; issueId: string; relatedIssueId: string };
  } {
    const body = requireBody(raw);
    const issue = this.requireIssueRef(ref, 404);
    const type = requireString(body, "type");
    const target = this.requireIssueRef(requireString(body, "target"), 400);
    let spec: { relType: "blocks" | "related"; issueId: string; relatedIssueId: string };
    if (type === "blocks") {
      spec = { relType: "blocks", issueId: issue.id, relatedIssueId: target.id };
    } else if (type === "blocked-by") {
      spec = { relType: "blocks", issueId: target.id, relatedIssueId: issue.id };
    } else if (type === "related" || type === "related-to") {
      spec = { relType: "related", issueId: issue.id, relatedIssueId: target.id };
    } else {
      throw new ServiceError(400, "type must be one of blocks, blocked-by, related");
    }
    if (spec.issueId === spec.relatedIssueId) {
      throw new ServiceError(400, "an issue cannot relate to itself");
    }
    let existing = findRelation(this.db, spec.relType, spec.issueId, spec.relatedIssueId);
    if (existing === undefined && spec.relType === "related") {
      // `related` is symmetric — either stored direction is the same edge.
      existing = findRelation(this.db, spec.relType, spec.relatedIssueId, spec.issueId);
    }
    if (existing !== undefined) {
      return {
        created: false,
        relation: {
          id: existing.id,
          type: existing.relType ?? spec.relType,
          issueId: existing.issueId ?? spec.issueId,
          relatedIssueId: existing.relatedIssueId ?? spec.relatedIssueId,
        },
      };
    }
    const relationId = ulid();
    this.appendAsActor(
      actor,
      [
        {
          op: "relate",
          model: "issue_relation",
          modelId: relationId,
          data: { type: spec.relType, issueId: spec.issueId, relatedIssueId: spec.relatedIssueId },
        },
      ],
      `kanon issue relate ${issue.identifier ?? issue.id}`,
    );
    return {
      created: true,
      relation: {
        id: relationId,
        type: spec.relType,
        issueId: spec.issueId,
        relatedIssueId: spec.relatedIssueId,
      },
    };
  }

  // -- webhooks -------------------------------------------------------------

  private webhookTargets(): WebhookDeliveryTarget[] {
    const targets: WebhookDeliveryTarget[] = [];
    for (const record of listModelEntities(this.db, "webhook")) {
      const url = record.data.url;
      const secret = record.data.secret;
      const resourceTypes = record.data.resourceTypes;
      if (
        typeof url !== "string" ||
        typeof secret !== "string" ||
        !Array.isArray(resourceTypes) ||
        resourceTypes.some((item) => typeof item !== "string")
      ) {
        this.warn(`kanon-server: webhook ${record.id} has malformed data — skipping`);
        continue;
      }
      targets.push({
        id: record.id,
        url,
        secret,
        resourceTypes: resourceTypes as string[],
        createdAt: record.createdAt,
      });
    }
    return targets;
  }

  /** Delivery view — includes secrets. For the in-process deliverer only. */
  webhooksForDelivery(): WebhookDeliveryTarget[] {
    return this.webhookTargets();
  }

  /** Client view — secrets never leave the server. */
  listWebhooks(): WebhookRecord[] {
    return this.webhookTargets().map(({ secret: _secret, ...record }) => record);
  }

  createWebhook(actor: EventActor, raw: unknown): WebhookRecord {
    const body = requireBody(raw);
    const url = requireString(body, "url");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ServiceError(400, "url must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ServiceError(400, "url must be http(s)");
    }
    const secret = requireString(body, "secret");
    const resourceTypes = optionalStringArray(body, "resourceTypes");
    if (resourceTypes === undefined || resourceTypes.length === 0) {
      throw new ServiceError(400, "resourceTypes must be a non-empty array of model names");
    }
    for (const resourceType of resourceTypes) {
      if (!MODELS.includes(resourceType as Model)) {
        throw new ServiceError(
          400,
          `unknown resourceType "${resourceType}" — must be one of ${MODELS.join(", ")}`,
        );
      }
    }
    const webhookId = ulid();
    this.appendAsActor(
      actor,
      [
        {
          op: "create",
          model: "webhook",
          modelId: webhookId,
          data: { url, secret, resourceTypes },
        },
      ],
      "kanon webhook create",
    );
    const created = this.webhookTargets().find((target) => target.id === webhookId);
    return created === undefined
      ? { id: webhookId, url, resourceTypes, createdAt: new Date().toISOString() }
      : {
          id: created.id,
          url: created.url,
          resourceTypes: created.resourceTypes,
          createdAt: created.createdAt,
        };
  }

  deleteWebhook(actor: EventActor, id: string): { deleted: string } {
    if (!ULID_PATTERN.test(id)) {
      throw new ServiceError(400, "webhook id must be a ULID");
    }
    const existing = this.webhookTargets().find((target) => target.id === id);
    if (existing === undefined) {
      throw new ServiceError(404, `no webhook ${id}`);
    }
    this.appendAsActor(
      actor,
      [{ op: "delete", model: "webhook", modelId: id, data: {} }],
      "kanon webhook delete",
    );
    return { deleted: id };
  }
}
