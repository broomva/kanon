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
  AGENT_ACTIVITY_TYPES,
  AGENT_SESSION_STATES,
  type AgentActivityType,
  type AgentSessionState,
  createEvent,
  type EventActor,
  issueLabelId,
  type KanonEvent,
  MODELS,
  type Model,
  nextSessionState,
  type Op,
  ULID_PATTERN,
  ulid,
  validateEvent,
} from "@kanon/core";
import {
  type ActorRecord,
  type AgentActivityRecord,
  type AgentSessionRecord,
  allocateDisplayNumber,
  appendEvents,
  type BaseRecord,
  type CommentRecord,
  DEFAULT_STATES,
  findAllRelations,
  findRelation,
  getAgentSession,
  getComment,
  getIssue,
  type IssueFilters,
  type IssueRecord,
  type LabelRecord,
  listActors,
  listAgentActivities,
  listAgentSessions,
  listComments,
  listIssues,
  listLabels,
  listMilestones,
  listModelEntities,
  listProjects,
  listRelations,
  listStates,
  listTeams,
  loadLog,
  type MilestoneRecord,
  openProjection,
  type Projection,
  type ProjectRecord,
  type RelationRecord,
  readDataRepoMeta,
  readyIssues,
  resolveActors,
  resolveInitiatives,
  resolveLabels,
  resolveMilestones,
  resolveProjects,
  resolveStates,
  resolveStatusUpdates,
  resolveTeams,
  type StateRecord,
  TEAM_KEY_PATTERN,
  type TeamRecord,
  withMetaLock,
} from "@kanon/store";
import { EventBus } from "./bus";
import { commitLog, isGitRepo, pullRebaseLog, pushLog } from "./git";
import { isPrivateWebhookHost } from "./webhook-guard";

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
  /**
   * Allow webhook targets on loopback / link-local / private ranges. Default
   * false (SSRF guard on). Tests and trusted single-tenant deploys set it via
   * KANON_WEBHOOK_ALLOW_PRIVATE=1.
   */
  allowPrivateWebhooks?: boolean;
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

/**
 * Tri-state read for null-to-remove fields: absent → undefined (leave
 * unchanged), explicit null → null (clear the seat), string → the reference.
 */
function stringOrNull(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ServiceError(400, `${field} must be a string or null`);
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

const STATUS_UPDATE_HEALTH = ["onTrack", "atRisk", "offTrack"] as const;

/** Guard the status-update health enum; undefined (unset) passes. */
function assertHealth(health: string | undefined): void {
  if (health !== undefined && !(STATUS_UPDATE_HEALTH as readonly string[]).includes(health)) {
    throw new ServiceError(400, `health must be one of ${STATUS_UPDATE_HEALTH.join(" | ")}`);
  }
}

/** Filters for `listStatusUpdates` — parent (project/initiative), type, author. */
export interface StatusUpdateFilter {
  type?: string | undefined;
  project?: string | undefined;
  initiative?: string | undefined;
  authorId?: string | undefined;
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
  private readonly allowPrivateWebhooks: boolean;
  private readonly warn: (message: string) => void;
  /** The merged canonical stream, ULID-ascending — moved only by reload(). */
  private log: KanonEvent[] = [];
  private knownIds = new Set<string>();

  constructor(options: ServiceOptions) {
    this.dataDir = options.dataDir;
    this.gitRemoteSync = options.gitRemoteSync;
    this.allowPrivateWebhooks = options.allowPrivateWebhooks ?? false;
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
    // Only reuse a label that belongs to THIS team (or is global, teamId null).
    // Otherwise an issue could attach another team's team-scoped label — the
    // same name in a different team is a distinct label, minted below.
    const matches = resolveLabels(this.db, ref).filter(
      (label) => label.teamId === teamId || label.teamId === null,
    );
    if (matches.length > 1) {
      throw new ServiceError(
        400,
        `ambiguous label "${ref}" — candidates: ${describeCandidates(matches)}`,
      );
    }
    const existing = matches[0];
    if (existing !== undefined) return existing.id;
    // A ULID ref named a specific label that isn't in this team's scope (or
    // doesn't exist) — refuse rather than mint a label literally named after
    // the id. Name refs fall through to mint a new team-scoped label.
    if (ULID_PATTERN.test(ref)) {
      throw new ServiceError(400, `label ${ref} not found in this team`);
    }
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

  /**
   * The read-only bootstrap the web UI loads once to resolve the references
   * carried on issues (stateId / labelIds / assigneeId / delegateId /
   * projectId / milestoneId) into names, colours, and board columns. One
   * workspace = one data repo, so this is inherently tenant-scoped: a Stimulus
   * server can only ever return Stimulus rows.
   */
  catalog(): {
    workspace: string;
    teams: TeamRecord[];
    states: StateRecord[];
    projects: ProjectRecord[];
    labels: LabelRecord[];
    actors: ActorRecord[];
    milestones: MilestoneRecord[];
  } {
    return {
      workspace: this.workspace,
      teams: listTeams(this.db),
      states: listStates(this.db),
      projects: listProjects(this.db),
      labels: listLabels(this.db),
      actors: listActors(this.db),
      milestones: listMilestones(this.db),
    };
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
            // No dedicated columns — preserved via the data_json overflow.
            summary: optionalString(body, "summary"),
            startDate: optionalString(body, "startDate"),
          }),
        },
      ],
      `kanon project create ${name}`,
    );
    return resolveProjects(this.db, projectId)[0] ?? null;
  }

  /**
   * PATCH-equivalent project update: name (uniqueness enforced), description,
   * state, targetDate (tri-state — explicit null clears the date).
   */
  updateProject(actor: EventActor, ref: string, raw: unknown): ProjectRecord | null {
    const body = requireBody(raw);
    const project = this.requireProjectRef(ref);
    const name = optionalString(body, "name");
    if (name !== undefined) {
      const clash = resolveProjects(this.db, name).filter((match) => match.id !== project.id);
      if (clash.length > 0) {
        throw new ServiceError(409, `a project named "${name}" already exists`);
      }
    }
    const data = compact({
      name,
      description: optionalString(body, "description"),
      state: optionalString(body, "state"),
      targetDate: stringOrNull(body, "targetDate"),
      // No dedicated columns — preserved via the data_json overflow.
      summary: optionalString(body, "summary"),
      startDate: optionalString(body, "startDate"),
    });
    if (Object.keys(data).length === 0) {
      throw new ServiceError(400, "update requires at least one field");
    }
    this.appendAsActor(
      actor,
      [{ op: "update", model: "project", modelId: project.id, data }],
      `kanon project update ${project.name ?? project.id}`,
    );
    return resolveProjects(this.db, project.id)[0] ?? null;
  }

  // -- initiatives (umbrella over projects; stored in other_entities) -----------

  listInitiatives(): BaseRecord[] {
    return listModelEntities(this.db, "initiative");
  }

  /** Resolve an initiative ref (ULID or exact name) or throw a typed error. */
  private requireInitiativeRef(ref: string): BaseRecord {
    const matches = resolveInitiatives(this.db, ref);
    if (matches.length > 1) {
      throw new ServiceError(
        400,
        `ambiguous initiative "${ref}" — candidates: ${matches.map((m) => m.id).join(", ")}`,
      );
    }
    const first = matches[0];
    if (first === undefined) throw new ServiceError(404, `no initiative matching "${ref}"`);
    return first;
  }

  createInitiative(actor: EventActor, raw: unknown): BaseRecord | null {
    const body = requireBody(raw);
    const name = requireString(body, "name");
    if (resolveInitiatives(this.db, name).length > 0) {
      throw new ServiceError(409, `an initiative named "${name}" already exists`);
    }
    const initiativeId = ulid();
    this.appendAsActor(
      actor,
      [
        {
          op: "create",
          model: "initiative",
          modelId: initiativeId,
          // No dedicated columns — every field rides the data_json overflow.
          data: compact({
            name,
            description: optionalString(body, "description"),
            targetDate: optionalString(body, "targetDate"),
            status: optionalString(body, "status"),
            summary: optionalString(body, "summary"),
            ownerId: optionalString(body, "owner"),
            color: optionalString(body, "color"),
            icon: optionalString(body, "icon"),
            priority: optionalInt(body, "priority", 0, 4),
          }),
        },
      ],
      `kanon initiative create ${name}`,
    );
    return resolveInitiatives(this.db, initiativeId)[0] ?? null;
  }

  /** PATCH-equivalent: name (uniqueness enforced), plus overflow fields. */
  updateInitiative(actor: EventActor, ref: string, raw: unknown): BaseRecord | null {
    const body = requireBody(raw);
    const initiative = this.requireInitiativeRef(ref);
    const name = optionalString(body, "name");
    if (name !== undefined) {
      const clash = resolveInitiatives(this.db, name).filter((m) => m.id !== initiative.id);
      if (clash.length > 0) {
        throw new ServiceError(409, `an initiative named "${name}" already exists`);
      }
    }
    const data = compact({
      name,
      description: optionalString(body, "description"),
      targetDate: stringOrNull(body, "targetDate"),
      status: optionalString(body, "status"),
      summary: optionalString(body, "summary"),
      ownerId: stringOrNull(body, "owner"),
      color: optionalString(body, "color"),
      icon: optionalString(body, "icon"),
      priority: optionalInt(body, "priority", 0, 4),
    });
    if (Object.keys(data).length === 0) {
      throw new ServiceError(400, "update requires at least one field");
    }
    this.appendAsActor(
      actor,
      [{ op: "update", model: "initiative", modelId: initiative.id, data }],
      `kanon initiative update ${String(initiative.data.name ?? initiative.id)}`,
    );
    return resolveInitiatives(this.db, initiative.id)[0] ?? null;
  }

  // -- status updates (health on a project/initiative; stored in other_entities)

  /** Filter status updates over the parsed `data` (parent/type/author). */
  listStatusUpdates(filter: StatusUpdateFilter = {}): BaseRecord[] {
    let all = listModelEntities(this.db, "status_update");
    if (filter.type !== undefined) all = all.filter((u) => u.data.type === filter.type);
    if (filter.project !== undefined) {
      const pid = resolveProjects(this.db, filter.project)[0]?.id;
      all = pid === undefined ? [] : all.filter((u) => u.data.projectId === pid);
    }
    if (filter.initiative !== undefined) {
      const iid = resolveInitiatives(this.db, filter.initiative)[0]?.id;
      all = iid === undefined ? [] : all.filter((u) => u.data.initiativeId === iid);
    }
    if (filter.authorId !== undefined) all = all.filter((u) => u.data.authorId === filter.authorId);
    return all;
  }

  private requireStatusUpdateRef(ref: string): BaseRecord {
    const first = resolveStatusUpdates(this.db, ref)[0];
    if (first === undefined) throw new ServiceError(404, `no status update matching "${ref}"`);
    return first;
  }

  createStatusUpdate(actor: EventActor, raw: unknown): BaseRecord | null {
    const body = requireBody(raw);
    const type = requireString(body, "type");
    if (type !== "project" && type !== "initiative") {
      throw new ServiceError(400, 'status update type must be "project" or "initiative"');
    }
    const health = optionalString(body, "health");
    assertHealth(health);
    const data: Record<string, unknown> = {
      type,
      health,
      body: optionalString(body, "body"),
      authorId: actor.id,
    };
    if (type === "project") {
      const ref = requireString(body, "project");
      const project = resolveProjects(this.db, ref)[0];
      if (project === undefined) throw new ServiceError(404, `no project matching "${ref}"`);
      data.projectId = project.id;
    } else {
      const ref = requireString(body, "initiative");
      const initiative = resolveInitiatives(this.db, ref)[0];
      if (initiative === undefined) throw new ServiceError(404, `no initiative matching "${ref}"`);
      data.initiativeId = initiative.id;
    }
    const updateId = ulid();
    this.appendAsActor(
      actor,
      [{ op: "create", model: "status_update", modelId: updateId, data: compact(data) }],
      `kanon status_update create ${type} ${String(data.projectId ?? data.initiativeId)}`,
    );
    return resolveStatusUpdates(this.db, updateId)[0] ?? null;
  }

  /** PATCH-equivalent: only the mutable fields (health, body). */
  updateStatusUpdate(actor: EventActor, ref: string, raw: unknown): BaseRecord | null {
    const body = requireBody(raw);
    const update = this.requireStatusUpdateRef(ref);
    const health = optionalString(body, "health");
    assertHealth(health);
    const data = compact({ health, body: optionalString(body, "body") });
    if (Object.keys(data).length === 0) {
      throw new ServiceError(400, "update requires at least one field");
    }
    this.appendAsActor(
      actor,
      [{ op: "update", model: "status_update", modelId: update.id, data }],
      `kanon status_update update ${update.id}`,
    );
    return resolveStatusUpdates(this.db, update.id)[0] ?? null;
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
    // Labels are OR-Set edges, not a whole-array field (BRO-1678): attach each
    // as an issue_label relate edge keyed by its deterministic (issue,label) id.
    const labelEdges: EventInput[] = labelIds.map((labelId) => ({
      op: "relate",
      model: "issue_label",
      modelId: issueLabelId(issueId, labelId),
      data: { issueId, labelId },
    }));
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
          }),
        },
        ...labelEdges,
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

  /**
   * PATCH /v1/issues/:ref — per-field LWW update event. The reference seats
   * (assignee, delegate, project, parent, milestone) are tri-state: absent
   * leaves the seat, a string re-points it, an explicit null CLEARS it
   * (Linear's "null to remove" — the update event carries `field: null`,
   * which replay applies per-field LWW like any other write).
   */
  updateIssue(actor: EventActor, ref: string, raw: unknown): IssueRecord | null {
    const body = requireBody(raw);
    const issue = this.requireIssueRef(ref, 404);
    const mints: EventInput[] = [];

    const stateRef = optionalString(body, "state");
    const stateId =
      stateRef === undefined ? undefined : this.requireStateRef(stateRef, issue.teamId ?? "").id;
    const assigneeRef = stringOrNull(body, "assignee");
    const assigneeId =
      assigneeRef === undefined || assigneeRef === null
        ? assigneeRef
        : this.actorRefEntity(assigneeRef, "assignee", mints);
    const delegateRef = stringOrNull(body, "delegate");
    const delegateId =
      delegateRef === undefined || delegateRef === null
        ? delegateRef
        : this.actorRefEntity(delegateRef, "delegate", mints);
    const projectRef = stringOrNull(body, "project");
    const projectId =
      projectRef === undefined || projectRef === null
        ? projectRef
        : this.requireProjectRef(projectRef).id;
    const parentRef = stringOrNull(body, "parent");
    const parentId =
      parentRef === undefined || parentRef === null
        ? parentRef
        : this.requireIssueRef(parentRef, 400).id;
    const milestoneRef = stringOrNull(body, "milestone");
    let milestoneId: string | null | undefined;
    if (milestoneRef === null) {
      milestoneId = null;
    } else if (milestoneRef !== undefined) {
      const matches = resolveMilestones(this.db, milestoneRef, projectId ?? undefined);
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

    const replaceLabels = optionalStringArray(body, "labels");
    const addLabels = optionalStringArray(body, "addLabels") ?? [];
    const removeLabels = optionalStringArray(body, "removeLabels") ?? [];
    const labelsRequested =
      replaceLabels !== undefined || addLabels.length > 0 || removeLabels.length > 0;
    const labelEdges: EventInput[] = [];
    if (labelsRequested) {
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
      // Emit only the DELTA as OR-Set edges (BRO-1678): a relate per newly
      // attached label, an unrelate per removed one, each keyed by the
      // deterministic (issue,label) id. Concurrent attaches of different
      // labels union instead of clobbering a shared array, and an unrelate
      // removes a label carried only in a legacy whole-array field too.
      const current = new Set(issue.labelIds);
      for (const labelId of next) {
        if (!current.has(labelId)) {
          labelEdges.push({
            op: "relate",
            model: "issue_label",
            modelId: issueLabelId(issue.id, labelId),
            data: { issueId: issue.id, labelId },
          });
        }
      }
      for (const labelId of current) {
        if (!next.has(labelId)) {
          labelEdges.push({
            op: "unrelate",
            model: "issue_label",
            modelId: issueLabelId(issue.id, labelId),
            data: { issueId: issue.id, labelId },
          });
        }
      }
    }

    const data = compact({
      stateId,
      title: optionalString(body, "title"),
      description: optionalString(body, "description"),
      priority: optionalInt(body, "priority", 0, 4),
      estimate: optionalNumber(body, "estimate"),
      assigneeId,
      delegateId,
      projectId,
      parentId,
      milestoneId,
    });
    const issueUpdate: EventInput[] =
      Object.keys(data).length > 0
        ? [{ op: "update", model: "issue", modelId: issue.id, data }]
        : [];
    const inputs = [...mints, ...issueUpdate, ...labelEdges];
    if (inputs.length === 0) {
      // Nothing to write. A requested label op that netted no change is an
      // idempotent no-op; a request with no fields at all is an error.
      if (!labelsRequested) {
        throw new ServiceError(400, "update requires at least one field");
      }
      return getIssue(this.db, issue.id) ?? null;
    }
    this.appendAsActor(actor, inputs, `kanon issue update ${issue.identifier ?? issue.id}`);
    return getIssue(this.db, issue.id) ?? null;
  }

  /**
   * POST /v1/issues/:ref/comments — actor entity minted on first use.
   * `parentId` makes it a reply; threads nest ONE level (Linear semantics),
   * so the parent must itself be a top-level comment on the same issue.
   */
  comment(
    actor: EventActor,
    ref: string,
    raw: unknown,
  ): { id: string; issueId: string; body: string; actorId: string; parentId?: string } {
    const body = requireBody(raw);
    const issue = this.requireIssueRef(ref, 404);
    const text = requireString(body, "body");
    const parentRef = optionalString(body, "parentId");
    let parentId: string | undefined;
    if (parentRef !== undefined) {
      if (!ULID_PATTERN.test(parentRef)) {
        throw new ServiceError(400, "parentId must be a comment ULID");
      }
      const parent = getComment(this.db, parentRef);
      if (parent === undefined || parent.issueId !== issue.id) {
        throw new ServiceError(400, `no comment ${parentRef} on ${issue.identifier ?? issue.id}`);
      }
      if (parent.parentId !== null) {
        throw new ServiceError(
          400,
          "replies nest one level — reply to the thread's top-level comment",
        );
      }
      parentId = parent.id;
    }
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
          data: compact({ issueId: issue.id, body: text, actorId, parentId }),
        },
      ],
      `kanon issue comment ${issue.identifier ?? issue.id}`,
    );
    return {
      id: commentId,
      issueId: issue.id,
      body: text,
      actorId,
      ...(parentId === undefined ? {} : { parentId }),
    };
  }

  /** Edit a comment's body (per-field LWW; authorship is logged, not enforced). */
  updateComment(
    actor: EventActor,
    commentId: string,
    raw: unknown,
  ): { id: string; issueId: string | null; body: string } {
    const body = requireBody(raw);
    if (!ULID_PATTERN.test(commentId)) {
      throw new ServiceError(400, "comment id must be a ULID");
    }
    const existing = getComment(this.db, commentId);
    if (existing === undefined) {
      throw new ServiceError(404, `no comment ${commentId}`);
    }
    const text = requireString(body, "body");
    this.appendAsActor(
      actor,
      [{ op: "update", model: "comment", modelId: commentId, data: { body: text } }],
      `kanon comment update ${commentId}`,
    );
    return { id: commentId, issueId: existing.issueId, body: text };
  }

  /**
   * POST /v1/issues/:ref/relations {type, target}. Direction convention
   * (matches the CLI + Linear importer): `{blocks, issue_id: A,
   * related_issue_id: B}` means A BLOCKS B; `blocked-by` flips it; `related`
   * is symmetric.
   */
  /** Parse {type, target} into the stored direction + find the existing edge. */
  private relationSpec(
    issue: IssueRecord,
    raw: unknown,
  ): {
    spec: { relType: "blocks" | "related"; issueId: string; relatedIssueId: string };
    existing: RelationRecord | undefined;
  } {
    const body = requireBody(raw);
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
    return { spec, existing };
  }

  relate(
    actor: EventActor,
    ref: string,
    raw: unknown,
  ): {
    created: boolean;
    relation: { id: string; type: string; issueId: string; relatedIssueId: string };
  } {
    const issue = this.requireIssueRef(ref, 404);
    const { spec, existing } = this.relationSpec(issue, raw);
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

  /**
   * The mirror of relate(): tombstone the matching edge via an `unrelate`
   * event. Idempotent — removing an edge that doesn't exist reports
   * `removed: false` (the desired end-state already holds) rather than
   * erroring or pretending a write happened.
   */
  unrelate(
    actor: EventActor,
    ref: string,
    raw: unknown,
  ): {
    removed: boolean;
    relation?: { id: string; type: string; issueId: string; relatedIssueId: string };
  } {
    const issue = this.requireIssueRef(ref, 404);
    const { spec } = this.relationSpec(issue, raw);
    // Tombstone EVERY entity for this logical edge, not just the first match:
    // two clones can have minted duplicate edges offline, and removing one
    // would leave the issue blocked. findAllRelations folds in the symmetric
    // direction for `related`.
    const matches = findAllRelations(this.db, spec.relType, spec.issueId, spec.relatedIssueId);
    const first = matches[0];
    if (first === undefined) {
      return { removed: false };
    }
    this.appendAsActor(
      actor,
      matches.map((rel) => ({
        op: "unrelate" as const,
        model: "issue_relation" as const,
        modelId: rel.id,
        data: {},
      })),
      `kanon issue unrelate ${issue.identifier ?? issue.id}`,
    );
    return {
      removed: true,
      relation: {
        id: first.id,
        type: first.relType ?? spec.relType,
        issueId: first.issueId ?? spec.issueId,
        relatedIssueId: first.relatedIssueId ?? spec.relatedIssueId,
      },
    };
  }

  // -- agent sessions + activities (M3 Phase 2, BRO-1649) --------------------
  //
  // The delegation platform: an agent_session binds an agent actor to an
  // issue; agent_activity events are the live timeline. Session state is
  // DERIVED — it moves only via activity appends (nextSessionState) and the
  // stale janitor, never set directly, so the activity log IS the source of
  // truth for where a delegation stands.

  private requireSessionRef(ref: string): AgentSessionRecord {
    if (!ULID_PATTERN.test(ref)) {
      throw new ServiceError(400, "agent session id must be a 26-char ULID");
    }
    const session = getAgentSession(this.db, ref);
    if (session === undefined || session.deleted) {
      throw new ServiceError(404, `no agent session ${ref}`);
    }
    return session;
  }

  /**
   * POST /v1/agent-sessions {issue, agent?, prompt?} — delegate an issue to
   * an agent. The session starts `pending` (delegated, not picked up); the
   * optional prompt is the delegation brief, recorded as the first activity.
   * Delegate-vs-assignee: the issue's delegate seat is re-pointed at the
   * session's agent (the assignee — the human owner — is untouched).
   */
  createAgentSession(
    actor: EventActor,
    raw: unknown,
  ): { session: AgentSessionRecord | null; activity: AgentActivityRecord | null } {
    const body = requireBody(raw);
    const issue = this.requireIssueRef(requireString(body, "issue"), 400);
    const prompt = optionalString(body, "prompt");
    const mints: EventInput[] = [];
    const agentRef = optionalString(body, "agent");
    let agentId: string;
    if (agentRef !== undefined) {
      agentId = this.actorRefEntity(agentRef, "delegate", mints);
    } else {
      // No agent named: the caller delegates to itself (an agent MCP
      // opening its own session on pickup).
      const authed = this.authedActorEntity(actor);
      agentId = authed.id;
      if (authed.mint !== undefined) mints.push(authed.mint);
    }
    const sessionId = ulid();
    const activityId = prompt === undefined ? undefined : ulid();
    const inputs: EventInput[] = [
      ...mints,
      {
        op: "create",
        model: "agent_session",
        modelId: sessionId,
        data: { issueId: issue.id, actorId: agentId, state: "pending" },
      },
    ];
    if (prompt !== undefined && activityId !== undefined) {
      inputs.push({
        op: "create",
        model: "agent_activity",
        modelId: activityId,
        data: { sessionId, type: "prompt", body: prompt },
      });
    }
    if (issue.delegateId !== agentId) {
      inputs.push({
        op: "update",
        model: "issue",
        modelId: issue.id,
        data: { delegateId: agentId },
      });
    }
    this.appendAsActor(actor, inputs, `kanon agent-session create ${issue.identifier ?? issue.id}`);
    return {
      session: getAgentSession(this.db, sessionId) ?? null,
      activity:
        activityId === undefined
          ? null
          : (listAgentActivities(this.db, sessionId).find((entry) => entry.id === activityId) ??
            null),
    };
  }

  /** GET /v1/agent-sessions — filter by issue ref, agent ref, session state. */
  agentSessions(query: Record<string, string | undefined>): AgentSessionRecord[] {
    const state = query.state;
    if (state !== undefined && !AGENT_SESSION_STATES.includes(state as AgentSessionState)) {
      throw new ServiceError(400, `state must be one of ${AGENT_SESSION_STATES.join(", ")}`);
    }
    const issueId =
      query.issue === undefined ? undefined : this.requireIssueRef(query.issue, 400).id;
    let actorId: string | undefined;
    if (query.agent !== undefined) {
      const matches = resolveActors(this.db, query.agent);
      const first = matches[0];
      if (matches.length === 0) {
        throw new ServiceError(400, `no actor matching "${query.agent}"`);
      }
      if (matches.length > 1 || first === undefined) {
        throw new ServiceError(
          400,
          `ambiguous agent "${query.agent}" — candidates: ${describeCandidates(matches)}`,
        );
      }
      actorId = first.id;
    }
    return listAgentSessions(this.db, {
      ...(issueId !== undefined && { issueId }),
      ...(actorId !== undefined && { actorId }),
      ...(state !== undefined && { state }),
    });
  }

  /** GET /v1/agent-sessions/:ref — session + its issue + the activity timeline. */
  agentSessionDetail(ref: string): {
    session: AgentSessionRecord;
    issue: IssueRecord | null;
    activities: AgentActivityRecord[];
  } {
    const session = this.requireSessionRef(ref);
    const issue = session.issueId === null ? null : (getIssue(this.db, session.issueId) ?? null);
    return { session, issue, activities: listAgentActivities(this.db, session.id) };
  }

  /**
   * POST /v1/agent-sessions/:ref/activities {type, body} — append to the
   * timeline and move the derived session state (nextSessionState is total:
   * thought/action → active, elicitation → awaitingInput, prompt answers →
   * active, response → complete, error → error).
   */
  appendAgentActivity(
    actor: EventActor,
    ref: string,
    raw: unknown,
  ): { activity: AgentActivityRecord | null; session: AgentSessionRecord | null } {
    const body = requireBody(raw);
    const session = this.requireSessionRef(ref);
    const type = requireString(body, "type");
    if (!AGENT_ACTIVITY_TYPES.includes(type as AgentActivityType)) {
      throw new ServiceError(400, `type must be one of ${AGENT_ACTIVITY_TYPES.join(", ")}`);
    }
    const text = requireString(body, "body");
    const current = AGENT_SESSION_STATES.includes(session.state as AgentSessionState)
      ? (session.state as AgentSessionState)
      : "pending";
    const next = nextSessionState(current, type as AgentActivityType);
    const activityId = ulid();
    const inputs: EventInput[] = [
      {
        op: "create",
        model: "agent_activity",
        modelId: activityId,
        data: { sessionId: session.id, type, body: text },
      },
    ];
    if (next !== current) {
      inputs.push({
        op: "update",
        model: "agent_session",
        modelId: session.id,
        data: { state: next },
      });
    }
    this.appendAsActor(actor, inputs, `kanon agent-activity ${type} ${session.id}`);
    return {
      activity:
        listAgentActivities(this.db, session.id).find((entry) => entry.id === activityId) ?? null,
      session: getAgentSession(this.db, session.id) ?? null,
    };
  }

  /**
   * The stale-session janitor: live sessions (pending / active /
   * awaitingInput) whose last movement — session update or newest activity —
   * is older than `olderThanMs` get marked `stale` in one batch. Complete,
   * error, and already-stale sessions are terminal for the janitor's
   * purposes and untouched (a follow-up prompt can still reactivate them).
   */
  markStaleSessions(actor: EventActor, olderThanMs: number): { staled: AgentSessionRecord[] } {
    if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
      throw new ServiceError(400, "olderThanMs must be a positive number of milliseconds");
    }
    const cutoff = Date.now() - olderThanMs;
    const staleIds: string[] = [];
    for (const state of ["pending", "active", "awaitingInput"]) {
      for (const session of listAgentSessions(this.db, { state })) {
        const lastMoved = Math.max(
          Date.parse(session.updatedAt),
          ...listAgentActivities(this.db, session.id).map((entry) => Date.parse(entry.createdAt)),
        );
        if (Number.isFinite(lastMoved) && lastMoved < cutoff) {
          staleIds.push(session.id);
        }
      }
    }
    if (staleIds.length === 0) {
      return { staled: [] };
    }
    this.appendAsActor(
      actor,
      staleIds.map(
        (id): EventInput => ({
          op: "update",
          model: "agent_session",
          modelId: id,
          data: { state: "stale" },
        }),
      ),
      `kanon agent-session janitor staled ${staleIds.length}`,
    );
    return {
      staled: staleIds
        .map((id) => getAgentSession(this.db, id))
        .filter((session): session is AgentSessionRecord => session !== undefined),
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
    if (!this.allowPrivateWebhooks && isPrivateWebhookHost(parsed.hostname)) {
      throw new ServiceError(
        400,
        `url host "${parsed.hostname}" is a loopback/link-local/private address — refused to ` +
          "prevent SSRF (set KANON_WEBHOOK_ALLOW_PRIVATE=1 to allow internal targets)",
      );
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
