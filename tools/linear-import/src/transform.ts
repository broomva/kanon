/**
 * Pure LinearExport → KanonEvent[] transform.
 *
 * Identity model:
 * - ULIDs are the entity keys. Every imported entity's event data carries its
 *   `linearId`, so re-runs can rebuild linearId → modelId from the log alone.
 * - Linear display identifiers (BRO-1234) are preserved verbatim in issue data
 *   (`number`, `identifier`) — display aliases, never keys.
 *
 * Idempotency:
 * - An entity whose linearId is already in the IdMap is skipped — unless it
 *   carries an updatedAt watermark (issues; tracked as `linearUpdatedAt` in
 *   event data) that differs from the map's, in which case exactly ONE update
 *   event is emitted. Update events carry the full current field set: the
 *   IdMap intentionally holds only {modelId, updatedAt, archived}, so a
 *   minimal diff is not computable — and Kanon's per-field last-write-wins
 *   merge makes a full-set update semantically equivalent to one.
 * - Issue relations carry no Linear id of their own, so a stable synthetic key
 *   `rel:<issueLinearId>:<type>:<relatedLinearId>` is written to data.linearId
 *   and re-runs dedupe through the same IdMap mechanism.
 *
 * Archival is an EXPLICIT op, never a data flag: the first import of an
 * archived issue emits create followed by an `archive` op event; when a
 * re-imported issue's archival state transitions, the (single) update event is
 * followed by an `archive`/`unarchive` op event — matching core's __archived
 * register semantics. buildIdMap folds those ops back into the IdMap.
 *
 * Timestamps are normalized at emission: any parseable Linear timestamp
 * (offsets like +03:00, locale-ish strings) becomes canonical UTC ISO-8601
 * before it reaches an event, so segment routing (segmentName) and watermark
 * comparison always operate on one representation. Event ts is the entity's
 * Linear updatedAt (fallback createdAt, fallback now); the event id still
 * carries import-time ordering.
 *
 * Unresolvable cross-references (a state/assignee/project/... linearId with no
 * modelId in the map) are DROPPED from event data but observable: each one is
 * recorded in summary.droppedRefs / summary.droppedByModel so callers can warn.
 * Repairing them on a later run where the target resolves is a follow-up.
 *
 * Ordering: events reference only modelIds introduced earlier in emission
 * order (teams → workflow_states → labels → users → projects → milestones →
 * initiatives → issues → issue_relations → comments). A sub-issue whose parent
 * appears later in the export is created without parentId and patched by a
 * second-pass update event after all issue events; comment replies are emitted
 * after top-level comments. Event ids use the in-process monotonic ulid(), so
 * ids strictly increase in emission order.
 *
 * Operational limits (see also tools/linear-import/README.md):
 * - Comments have no updatedAt watermark in the export — edited comment
 *   bodies do NOT re-sync after first import.
 * - Deletions and un-relations never propagate: the importer mirrors a
 *   snapshot forward; it only creates, updates, archives, unarchives.
 * - Because updates carry the full field set, do NOT run the importer against
 *   a repo receiving local writes to imported entities — a Linear-side change
 *   would clobber local edits field-by-field. Mirror-phase tool.
 */

import {
  createEvent,
  type EventActor,
  type KanonEvent,
  type Model,
  type Op,
  ulid,
} from "@kanon/core";
import type { LinearExport } from "./types";

/** linearId → existing entity key + Linear updatedAt watermark + archival state. */
export type IdMap = Map<string, { modelId: string; updatedAt?: string; archived?: boolean }>;

export const IMPORT_ACTOR: EventActor = {
  type: "app",
  id: "linear-import",
  surface: "import",
};

export interface ModelCounts {
  created: number;
  updated: number;
  skipped: number;
}

/** One unresolvable cross-reference, dropped from event data but reported. */
export interface DroppedRef {
  /** Model of the entity whose reference could not be resolved. */
  model: string;
  /** linearId of the referring entity. */
  linearId: string;
  /** Data field the reference would have populated. */
  field: string;
  /** The Linear id that had no modelId in the map. */
  ref: string;
}

export interface TransformSummary {
  created: number;
  updated: number;
  skipped: number;
  byModel: Record<string, ModelCounts>;
  droppedRefs: DroppedRef[];
  droppedByModel: Record<string, number>;
}

export interface TransformResult {
  events: KanonEvent[];
  summary: TransformSummary;
}

/** Drop undefined values so event data stays compact and deterministic. */
export function compact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Stable synthetic linearId for a relation (Linear relations lack ids here). */
export function relationKey(issueLinearId: string, type: string, relatedLinearId: string): string {
  return `rel:${issueLinearId}:${type}:${relatedLinearId}`;
}

/**
 * Normalize any parseable timestamp to canonical UTC ISO-8601. Unparseable or
 * absent values return undefined so callers fall through their ts chain.
 */
export function normalizeTs(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * Highest imported issue number per team KEY — used to seed the data repo's
 * meta.json displayCounters so locally minted identifiers never collide with
 * imported history (e.g. never mint BRO-1 over an imported BRO-1646).
 */
export function displayCounters(exp: LinearExport): Record<string, number> {
  const keyByTeam = new Map(exp.teams.map((team) => [team.linearId, team.key]));
  const counters: Record<string, number> = {};
  for (const issue of exp.issues) {
    const key = keyByTeam.get(issue.teamLinearId);
    if (key === undefined || typeof issue.number !== "number") continue;
    counters[key] = Math.max(counters[key] ?? 0, issue.number);
  }
  return counters;
}

interface ParentFixup {
  childModelId: string;
  childLinearId: string;
  parentLinearId: string;
  ts?: string;
}

export function transform(exp: LinearExport, existing: IdMap): TransformResult {
  const map: IdMap = new Map(existing);
  const events: KanonEvent[] = [];
  const summary: TransformSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    byModel: {},
    droppedRefs: [],
    droppedByModel: {},
  };

  const count = (model: Model, kind: keyof ModelCounts): void => {
    summary[kind] += 1;
    const counts = summary.byModel[model] ?? { created: 0, updated: 0, skipped: 0 };
    counts[kind] += 1;
    summary.byModel[model] = counts;
  };

  const idFor = (linearId: string | undefined): string | undefined =>
    linearId === undefined ? undefined : map.get(linearId)?.modelId;

  /** idFor + observability: an unresolvable (defined) ref is recorded, then dropped. */
  const resolve = (
    model: Model,
    entityLinearId: string,
    field: string,
    ref: string | undefined,
  ): string | undefined => {
    if (ref === undefined) return undefined;
    const modelId = map.get(ref)?.modelId;
    if (modelId === undefined) {
      summary.droppedRefs.push({ model, linearId: entityLinearId, field, ref });
      summary.droppedByModel[model] = (summary.droppedByModel[model] ?? 0) + 1;
    }
    return modelId;
  };

  const resolveAll = (
    model: Model,
    entityLinearId: string,
    field: string,
    refs: string[],
  ): string[] =>
    refs
      .map((ref) => resolve(model, entityLinearId, field, ref))
      .filter((id): id is string => id !== undefined);

  const emit = (
    op: Op,
    model: Model,
    modelId: string,
    data: Record<string, unknown>,
    ts?: string,
  ): void => {
    events.push(
      createEvent({
        workspace: exp.workspace,
        actor: IMPORT_ACTOR,
        op,
        model,
        modelId,
        data,
        ...(ts === undefined ? {} : { ts }),
      }),
    );
  };

  /**
   * Create-or-skip for entities without an updatedAt watermark in the export
   * (teams, states, labels, users, projects, milestones, initiatives): change
   * detection is scoped to issues, so a known linearId is always a skip.
   * Returns the entity's modelId either way. `data` is lazy so skipped
   * entities never record dropped refs.
   */
  const upsert = (
    model: Model,
    linearId: string,
    data: () => Record<string, unknown>,
    ts?: string,
  ): string => {
    const entry = map.get(linearId);
    if (entry !== undefined) {
      count(model, "skipped");
      return entry.modelId;
    }
    const modelId = ulid();
    map.set(linearId, { modelId });
    emit("create", model, modelId, compact({ ...data(), linearId }), ts);
    count(model, "created");
    return modelId;
  };

  // -- teams + workflow states ----------------------------------------------
  for (const team of exp.teams) {
    const teamId = upsert("team", team.linearId, () => ({ key: team.key, name: team.name }));
    for (const state of team.states) {
      upsert("workflow_state", state.linearId, () => ({
        teamId,
        name: state.name,
        type: state.type,
        color: state.color,
        position: state.position,
      }));
    }
  }

  // -- labels ----------------------------------------------------------------
  for (const label of exp.labels) {
    upsert("label", label.linearId, () => ({
      teamId: resolve("label", label.linearId, "teamId", label.teamLinearId),
      name: label.name,
      color: label.color,
    }));
  }

  // -- users → actors ---------------------------------------------------------
  for (const user of exp.users) {
    upsert("actor", user.linearId, () => ({
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      actorType: user.isAgent === true ? "agent" : "human",
    }));
  }

  // -- projects ----------------------------------------------------------------
  for (const project of exp.projects) {
    upsert("project", project.linearId, () => ({
      name: project.name,
      description: project.description,
      state: project.state,
      leadId: resolve("project", project.linearId, "leadId", project.leadLinearId),
      targetDate: project.targetDate,
      teamIds: resolveAll("project", project.linearId, "teamIds", project.teamLinearIds),
    }));
  }

  // -- milestones ---------------------------------------------------------------
  for (const milestone of exp.milestones) {
    upsert("milestone", milestone.linearId, () => ({
      projectId: resolve("milestone", milestone.linearId, "projectId", milestone.projectLinearId),
      name: milestone.name,
      targetDate: milestone.targetDate,
    }));
  }

  // -- initiatives ----------------------------------------------------------------
  for (const initiative of exp.initiatives) {
    upsert("initiative", initiative.linearId, () => ({
      name: initiative.name,
      description: initiative.description,
      targetDate: initiative.targetDate,
    }));
  }

  // -- issues -----------------------------------------------------------------
  // Second-pass parent patches: when a sub-issue's parent has no modelId yet
  // (forward reference within this export), the create omits parentId and one
  // update event sets it after all issue events. Fixup events are not counted
  // in the summary — the entity was already counted once.
  const parentFixups: ParentFixup[] = [];

  for (const issue of exp.issues) {
    const updatedAt = normalizeTs(issue.updatedAt);
    const entry = map.get(issue.linearId);
    if (entry !== undefined && entry.updatedAt === updatedAt) {
      count("issue", "skipped");
      continue;
    }

    const ts = updatedAt ?? normalizeTs(issue.createdAt);
    const archived = issue.archivedAt !== undefined;
    const archiveTs = normalizeTs(issue.archivedAt) ?? ts;
    // Parent refs resolve via plain idFor: an in-export forward reference is
    // NOT a dropped ref — the fixup pass patches or records it below.
    const parentLinearId = issue.parentLinearId;
    const parentId = idFor(parentLinearId);

    const data = compact({
      teamId: resolve("issue", issue.linearId, "teamId", issue.teamLinearId),
      number: issue.number,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      estimate: issue.estimate,
      stateId: resolve("issue", issue.linearId, "stateId", issue.stateLinearId),
      assigneeId: resolve("issue", issue.linearId, "assigneeId", issue.assigneeLinearId),
      parentId,
      projectId: resolve("issue", issue.linearId, "projectId", issue.projectLinearId),
      milestoneId: resolve("issue", issue.linearId, "milestoneId", issue.milestoneLinearId),
      labelIds: resolveAll("issue", issue.linearId, "labelIds", issue.labelLinearIds),
      linearId: issue.linearId,
      linearCreatedAt: normalizeTs(issue.createdAt),
      linearUpdatedAt: updatedAt,
    });

    let modelId: string;
    if (entry !== undefined) {
      // Known issue whose Linear updatedAt moved: exactly one update event,
      // plus an explicit archive/unarchive op if the archival state flipped.
      modelId = entry.modelId;
      emit("update", "issue", modelId, data, ts);
      count("issue", "updated");
      if (archived !== (entry.archived === true)) {
        emit(
          archived ? "archive" : "unarchive",
          "issue",
          modelId,
          { linearId: issue.linearId },
          archived ? archiveTs : ts,
        );
      }
    } else {
      modelId = ulid();
      emit("create", "issue", modelId, data, ts);
      count("issue", "created");
      if (archived) {
        emit("archive", "issue", modelId, { linearId: issue.linearId }, archiveTs);
      }
    }
    map.set(issue.linearId, {
      modelId,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(archived ? { archived: true } : {}),
    });

    if (parentLinearId !== undefined && parentId === undefined) {
      parentFixups.push({
        childModelId: modelId,
        childLinearId: issue.linearId,
        parentLinearId,
        ...(ts === undefined ? {} : { ts }),
      });
    }
  }

  for (const fixup of parentFixups) {
    // Resolvable now → patch; still unresolvable → observable dropped ref.
    const parentId = resolve("issue", fixup.childLinearId, "parentId", fixup.parentLinearId);
    if (parentId === undefined) continue;
    emit(
      "update",
      "issue",
      fixup.childModelId,
      { parentId, linearId: fixup.childLinearId },
      fixup.ts,
    );
  }

  // -- issue relations ----------------------------------------------------------
  for (const issue of exp.issues) {
    for (const relation of issue.relations) {
      const key = relationKey(issue.linearId, relation.type, relation.relatedIssueLinearId);
      if (map.has(key)) {
        count("issue_relation", "skipped");
        continue;
      }
      const issueId = resolve("issue_relation", key, "issueId", issue.linearId);
      const relatedIssueId = resolve(
        "issue_relation",
        key,
        "relatedIssueId",
        relation.relatedIssueLinearId,
      );
      if (issueId === undefined || relatedIssueId === undefined) {
        count("issue_relation", "skipped"); // dangling reference — nothing to link
        continue;
      }
      const modelId = ulid();
      map.set(key, { modelId });
      emit(
        "relate",
        "issue_relation",
        modelId,
        { type: relation.type, issueId, relatedIssueId, linearId: key },
        normalizeTs(issue.updatedAt) ?? normalizeTs(issue.createdAt),
      );
      count("issue_relation", "created");
    }
  }

  // -- comments (top-level before replies so parentId always resolves) -----------
  const topLevel = exp.comments.filter((c) => c.parentLinearId === undefined);
  const replies = exp.comments.filter((c) => c.parentLinearId !== undefined);
  for (const comment of [...topLevel, ...replies]) {
    if (map.has(comment.linearId)) {
      count("comment", "skipped");
      continue;
    }
    const issueId = resolve("comment", comment.linearId, "issueId", comment.issueLinearId);
    if (issueId === undefined) {
      count("comment", "skipped"); // comment on an issue we never saw
      continue;
    }
    const modelId = ulid();
    map.set(comment.linearId, { modelId });
    emit(
      "create",
      "comment",
      modelId,
      compact({
        issueId,
        body: comment.body,
        actorId: resolve("comment", comment.linearId, "actorId", comment.userLinearId),
        parentId: resolve("comment", comment.linearId, "parentId", comment.parentLinearId),
        linearId: comment.linearId,
        linearCreatedAt: normalizeTs(comment.createdAt),
      }),
      normalizeTs(comment.createdAt),
    );
    count("comment", "created");
  }

  return { events, summary };
}
