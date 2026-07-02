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
 *   IdMap intentionally holds only {modelId, updatedAt}, so a minimal diff is
 *   not computable — and Kanon's per-field last-write-wins merge makes a
 *   full-set update semantically equivalent to one.
 * - Issue relations carry no Linear id of their own, so a stable synthetic key
 *   `rel:<issueLinearId>:<type>:<relatedLinearId>` is written to data.linearId
 *   and re-runs dedupe through the same IdMap mechanism.
 *
 * Archived issues: the first import emits the create (with `archived: true` in
 * data for grep-ability) followed by an explicit `archive` op event, so
 * projections handle archival uniformly. When an already-imported issue
 * changes, the archived flag rides the single update event's data — no second
 * archive event is emitted.
 *
 * Ordering: events reference only modelIds introduced earlier in emission
 * order (teams → workflow_states → labels → users → projects → milestones →
 * initiatives → issues → issue_relations → comments). A sub-issue whose parent
 * appears later in the export is created without parentId and patched by a
 * second-pass update event after all issue events; comment replies are emitted
 * after top-level comments. Event ids use the in-process monotonic ulid(), so
 * ids strictly increase in emission order.
 *
 * Event ts is the entity's Linear updatedAt (fallback createdAt, fallback
 * now); the event id still carries import-time ordering.
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

/** linearId → existing entity key + last-seen Linear updatedAt watermark. */
export type IdMap = Map<string, { modelId: string; updatedAt?: string }>;

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

export interface TransformSummary {
  created: number;
  updated: number;
  skipped: number;
  byModel: Record<string, ModelCounts>;
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

interface ParentFixup {
  childModelId: string;
  childLinearId: string;
  parentLinearId: string;
  ts?: string;
}

export function transform(exp: LinearExport, existing: IdMap): TransformResult {
  const map: IdMap = new Map(existing);
  const events: KanonEvent[] = [];
  const summary: TransformSummary = { created: 0, updated: 0, skipped: 0, byModel: {} };

  const count = (model: Model, kind: keyof ModelCounts): void => {
    summary[kind] += 1;
    const counts = summary.byModel[model] ?? { created: 0, updated: 0, skipped: 0 };
    counts[kind] += 1;
    summary.byModel[model] = counts;
  };

  const idFor = (linearId: string | undefined): string | undefined =>
    linearId === undefined ? undefined : map.get(linearId)?.modelId;

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
   * Returns the entity's modelId either way.
   */
  const upsert = (
    model: Model,
    linearId: string,
    data: Record<string, unknown>,
    ts?: string,
  ): string => {
    const entry = map.get(linearId);
    if (entry !== undefined) {
      count(model, "skipped");
      return entry.modelId;
    }
    const modelId = ulid();
    map.set(linearId, { modelId });
    emit("create", model, modelId, compact({ ...data, linearId }), ts);
    count(model, "created");
    return modelId;
  };

  // -- teams + workflow states ----------------------------------------------
  for (const team of exp.teams) {
    const teamId = upsert("team", team.linearId, { key: team.key, name: team.name });
    for (const state of team.states) {
      upsert("workflow_state", state.linearId, {
        teamId,
        name: state.name,
        type: state.type,
        color: state.color,
        position: state.position,
      });
    }
  }

  // -- labels ----------------------------------------------------------------
  for (const label of exp.labels) {
    upsert("label", label.linearId, {
      teamId: idFor(label.teamLinearId),
      name: label.name,
      color: label.color,
    });
  }

  // -- users → actors ---------------------------------------------------------
  for (const user of exp.users) {
    upsert("actor", user.linearId, {
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      actorType: user.isAgent === true ? "agent" : "human",
    });
  }

  // -- projects ----------------------------------------------------------------
  for (const project of exp.projects) {
    upsert("project", project.linearId, {
      name: project.name,
      description: project.description,
      state: project.state,
      leadId: idFor(project.leadLinearId),
      targetDate: project.targetDate,
      teamIds: project.teamLinearIds
        .map((id) => idFor(id))
        .filter((id): id is string => id !== undefined),
    });
  }

  // -- milestones ---------------------------------------------------------------
  for (const milestone of exp.milestones) {
    upsert("milestone", milestone.linearId, {
      projectId: idFor(milestone.projectLinearId),
      name: milestone.name,
      targetDate: milestone.targetDate,
    });
  }

  // -- initiatives ----------------------------------------------------------------
  for (const initiative of exp.initiatives) {
    upsert("initiative", initiative.linearId, {
      name: initiative.name,
      description: initiative.description,
      targetDate: initiative.targetDate,
    });
  }

  // -- issues -----------------------------------------------------------------
  // Second-pass parent patches: when a sub-issue's parent has no modelId yet
  // (forward reference within this export), the create omits parentId and one
  // update event sets it after all issue events. Fixup events are not counted
  // in the summary — the entity was already counted once.
  const parentFixups: ParentFixup[] = [];

  for (const issue of exp.issues) {
    const entry = map.get(issue.linearId);
    if (entry !== undefined && entry.updatedAt === issue.updatedAt) {
      count("issue", "skipped");
      continue;
    }

    const ts = issue.updatedAt || issue.createdAt || undefined;
    const parentLinearId = issue.parentLinearId;
    const parentId = idFor(parentLinearId);

    const data = compact({
      teamId: idFor(issue.teamLinearId),
      number: issue.number,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      estimate: issue.estimate,
      stateId: idFor(issue.stateLinearId),
      assigneeId: idFor(issue.assigneeLinearId),
      parentId,
      projectId: idFor(issue.projectLinearId),
      milestoneId: idFor(issue.milestoneLinearId),
      labelIds: issue.labelLinearIds
        .map((id) => idFor(id))
        .filter((id): id is string => id !== undefined),
      linearId: issue.linearId,
      linearCreatedAt: issue.createdAt,
      linearUpdatedAt: issue.updatedAt,
      archived: issue.archivedAt !== undefined,
    });

    let modelId: string;
    if (entry !== undefined) {
      // Known issue whose Linear updatedAt moved: exactly one update event.
      modelId = entry.modelId;
      emit("update", "issue", modelId, data, ts);
      count("issue", "updated");
    } else {
      modelId = ulid();
      emit("create", "issue", modelId, data, ts);
      count("issue", "created");
      if (issue.archivedAt !== undefined) {
        emit("archive", "issue", modelId, { linearId: issue.linearId }, issue.archivedAt);
      }
    }
    map.set(issue.linearId, { modelId, updatedAt: issue.updatedAt });

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
    const parentId = idFor(fixup.parentLinearId);
    if (parentId === undefined) continue; // parent not in export or log — leave unset
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
      const issueId = idFor(issue.linearId);
      const relatedIssueId = idFor(relation.relatedIssueLinearId);
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
        issue.updatedAt || issue.createdAt || undefined,
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
    const issueId = idFor(comment.issueLinearId);
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
        actorId: idFor(comment.userLinearId),
        parentId: idFor(comment.parentLinearId),
        linearId: comment.linearId,
        linearCreatedAt: comment.createdAt,
      }),
      comment.createdAt,
    );
    count("comment", "created");
  }

  return { events, summary };
}
