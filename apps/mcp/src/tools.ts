/**
 * Tool handlers — each linear-server tool mapped onto the Kanon service core.
 *
 * Reads hit `@kanon/store` query functions against the projection
 * (`service.db`); writes go through `KanonService` so every mutation is the
 * same createEvent → append → commit → refresh → broadcast path the REST
 * server and CLI use. The handler returns markdown; the MCP layer wraps it.
 *
 * Kanon deliberately doesn't model some Linear concepts (initiatives,
 * releases, first-class cycles); those args are accepted for call-site
 * compatibility and either ignored or answered with an explicit "not in
 * Kanon v1" note rather than a hard failure.
 */

import type { EventActor } from "@kanon/core";
import type { KanonService } from "@kanon/service";
import { ServiceError } from "@kanon/service";
import {
  getIssue,
  listActors,
  listComments,
  listLabels,
  listModelEntities,
  listStates,
  resolveProjects,
  resolveTeams,
} from "@kanon/store";
import {
  formatIssueDetail,
  formatIssueList,
  formatLabelList,
  formatProject,
  formatProjectList,
  formatStateList,
  formatTeam,
  formatTeamList,
  formatUserList,
  type UserLine,
} from "./format";
import type { LinearToolName } from "./linear-schemas";

export interface ToolContext {
  service: KanonService;
  actor: EventActor;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => string;

// -- arg coercion -------------------------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ServiceError(400, `${key} must be a string`);
  return value;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (value === undefined || value.length === 0) {
    throw new ServiceError(400, `${key} is required`);
  }
  return value;
}

function strArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ServiceError(400, `${key} must be an array of strings`);
  }
  return value as string[];
}

/** Map Linear's "me" sentinel to the authenticated actor id. */
function resolveMe(ref: string | undefined, actor: EventActor): string | undefined {
  return ref === "me" ? actor.id : ref;
}

/** Drop undefined keys so KanonService's requireString/optionalString see clean input. */
function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// -- relation application (save_issue blocks/blockedBy/relatedTo) --------------

function applyRelations(
  ctx: ToolContext,
  issueRef: string,
  args: Record<string, unknown>,
): string[] {
  const notes: string[] = [];
  const add = (type: "blocks" | "blocked-by" | "related", targets: string[] | undefined) => {
    for (const target of targets ?? []) {
      const result = ctx.service.relate(ctx.actor, issueRef, { type, target });
      notes.push(result.created ? `+${type} ${target}` : `=${type} ${target} (existed)`);
    }
  };
  add("blocks", strArray(args, "blocks"));
  add("blocked-by", strArray(args, "blockedBy"));
  add("related", strArray(args, "relatedTo"));
  const removals = [
    ...(strArray(args, "removeBlocks") ?? []),
    ...(strArray(args, "removeBlockedBy") ?? []),
    ...(strArray(args, "removeRelatedTo") ?? []),
  ];
  if (removals.length > 0) notes.push("(relation removal lands in M3 Phase 2 — skipped)");
  return notes;
}

// -- handlers -----------------------------------------------------------------

export const TOOL_HANDLERS: Record<LinearToolName, ToolHandler> = {
  list_issues(args, ctx) {
    // Linear sentinels: "me" → the caller, "null" → unassigned. The store has
    // no unassigned filter, so drop the arg and post-filter for a null seat.
    const rawAssignee = str(args, "assignee");
    const rawDelegate = str(args, "delegate");
    const wantUnassigned = rawAssignee === "null";
    const wantUndelegated = rawDelegate === "null";
    const query = clean({
      team: str(args, "team"),
      state: str(args, "state"),
      assignee: wantUnassigned ? undefined : resolveMe(rawAssignee, ctx.actor),
      delegate: wantUndelegated ? undefined : resolveMe(rawDelegate, ctx.actor),
      project: str(args, "project"),
      label: str(args, "label"),
      priority: typeof args.priority === "number" ? String(args.priority) : undefined,
      parent: str(args, "parentId"),
      query: str(args, "query"),
      updatedAfter: str(args, "updatedAt"),
      includeArchived: args.includeArchived === false ? "false" : undefined,
      orderBy: str(args, "orderBy"),
      limit: typeof args.limit === "number" ? String(args.limit) : undefined,
    }) as Record<string, string | undefined>;
    let issues = ctx.service.issues(query);
    if (wantUnassigned) issues = issues.filter((issue) => issue.assigneeId === null);
    if (wantUndelegated) issues = issues.filter((issue) => issue.delegateId === null);
    return formatIssueList(ctx.service.db, issues, "## Issues");
  },

  get_issue(args, ctx) {
    const detail = ctx.service.issueDetail(requireStr(args, "id"));
    return formatIssueDetail(ctx.service.db, detail.issue, detail.comments, detail.relations);
  },

  save_issue(args, ctx) {
    const id = str(args, "id");
    // Linear's "Null to remove" (unassign, unparent, remove-from-project)
    // isn't wired through the write path yet. Reject it explicitly rather than
    // accept-and-silently-ignore, which would report a false success.
    for (const field of ["assignee", "delegate", "project", "parentId"]) {
      if (args[field] === null) {
        throw new ServiceError(
          422,
          `clearing "${field}" via null lands in M3 Phase 2 — omit the field to leave it unchanged`,
        );
      }
    }
    // project / milestone / parent apply on BOTH create and update (updateIssue
    // resolves and writes them), so they live in the shared field set.
    const shared = clean({
      title: str(args, "title"),
      description: str(args, "description"),
      priority: typeof args.priority === "number" ? args.priority : undefined,
      estimate: typeof args.estimate === "number" ? args.estimate : undefined,
      state: str(args, "state"),
      assignee: resolveMe(str(args, "assignee"), ctx.actor),
      delegate: resolveMe(str(args, "delegate"), ctx.actor),
      project: str(args, "project"),
      milestone: str(args, "milestone"),
      parent: str(args, "parentId"),
      labels: strArray(args, "labels"),
    });
    let ref: string;
    if (id === undefined) {
      const created = ctx.service.createIssue(
        ctx.actor,
        clean({ ...shared, team: requireStr(args, "team") }),
      );
      ref = created.id;
    } else {
      // A relations-only save (id + blocks/blockedBy/relatedTo, no field
      // changes) must skip updateIssue — it rejects an empty field set.
      if (Object.keys(shared).length > 0) ctx.service.updateIssue(ctx.actor, id, shared);
      ref = id;
    }
    const relationNotes = applyRelations(ctx, ref, args);
    const detail = ctx.service.issueDetail(ref);
    const body = formatIssueDetail(ctx.service.db, detail.issue, detail.comments, detail.relations);
    return relationNotes.length > 0 ? `${body}\n\n_Relations: ${relationNotes.join(", ")}_` : body;
  },

  list_teams(_args, ctx) {
    return formatTeamList(ctx.service.listTeams());
  },

  get_team(args, ctx) {
    const team = resolveTeams(ctx.service.db, requireStr(args, "query"))[0];
    if (team === undefined)
      throw new ServiceError(404, `no team matching "${requireStr(args, "query")}"`);
    return formatTeam(ctx.service.db, team);
  },

  list_projects(_args, ctx) {
    return formatProjectList(ctx.service.listProjects());
  },

  get_project(args, ctx) {
    const project = resolveProjects(ctx.service.db, requireStr(args, "query"))[0];
    if (project === undefined) {
      throw new ServiceError(404, `no project matching "${requireStr(args, "query")}"`);
    }
    return formatProject(project);
  },

  save_project(args, ctx) {
    if (str(args, "id") !== undefined) {
      throw new ServiceError(422, "project update lands in M3 Phase 2 — create-only for now");
    }
    const project = ctx.service.createProject(
      ctx.actor,
      clean({
        name: requireStr(args, "name"),
        description: str(args, "description"),
        targetDate: str(args, "targetDate"),
      }),
    );
    if (project === null) throw new ServiceError(500, "project create returned no record");
    return formatProject(project);
  },

  list_comments(args, ctx) {
    const issue = getIssue(ctx.service.db, requireStr(args, "issueId"));
    if (issue === undefined)
      throw new ServiceError(404, `no issue matching "${requireStr(args, "issueId")}"`);
    const comments = listComments(ctx.service.db, issue.id);
    if (comments.length === 0) return `_No comments on ${issue.identifier ?? issue.id}._`;
    const lines = comments.map(
      (comment) => `- (${comment.createdAt}) ${comment.actorId ?? "?"}: ${comment.body ?? ""}`,
    );
    return `## Comments on ${issue.identifier ?? issue.id} (${comments.length})\n\n${lines.join("\n")}`;
  },

  save_comment(args, ctx) {
    if (str(args, "id") !== undefined || str(args, "parentId") !== undefined) {
      throw new ServiceError(
        422,
        "comment edit/reply lands in M3 Phase 2 — new top-level issue comments only",
      );
    }
    const issueId = requireStr(args, "issueId");
    const result = ctx.service.comment(ctx.actor, issueId, { body: requireStr(args, "body") });
    return `Commented on ${issueId} (\`${result.id}\`).`;
  },

  list_issue_statuses(args, ctx) {
    const team = resolveTeams(ctx.service.db, requireStr(args, "team"))[0];
    if (team === undefined)
      throw new ServiceError(404, `no team matching "${requireStr(args, "team")}"`);
    return formatStateList(listStates(ctx.service.db, team.id));
  },

  list_issue_labels(args, ctx) {
    let labels = listLabels(ctx.service.db);
    const team = str(args, "team");
    if (team !== undefined) {
      const resolved = resolveTeams(ctx.service.db, team)[0];
      if (resolved !== undefined) labels = labels.filter((label) => label.teamId === resolved.id);
    }
    const name = str(args, "name");
    if (name !== undefined) {
      labels = labels.filter((label) =>
        (label.name ?? "").toLowerCase().includes(name.toLowerCase()),
      );
    }
    return formatLabelList(labels);
  },

  list_users(_args, ctx) {
    const users: UserLine[] = listActors(ctx.service.db).map((actor) => ({
      id: actor.id,
      name: actor.name,
      displayName: actor.displayName,
      email: actor.email,
      actorType: actor.actorType,
    }));
    return formatUserList(users);
  },

  list_cycles(args, ctx) {
    const teamId = requireStr(args, "teamId");
    const cycles = listModelEntities(ctx.service.db, "cycle").filter(
      (cycle) => cycle.data.teamId === teamId,
    );
    if (cycles.length === 0)
      return `_No cycles for team ${teamId}._ (Kanon does not schedule cycles in v1.)`;
    return `## Cycles (${cycles.length})\n\n${cycles.map((cycle) => `- \`${cycle.id}\``).join("\n")}`;
  },
};
