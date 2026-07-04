/**
 * Tool handlers — each linear-server tool mapped onto the Kanon service core.
 *
 * Reads hit `@kanon/store` query functions against the projection
 * (`service.db`); writes go through `KanonService` so every mutation is the
 * same createEvent → append → commit → refresh → broadcast path the REST
 * server and CLI use. The handler returns markdown; the MCP layer wraps it.
 *
 * Kanon deliberately doesn't model a few Linear concepts (releases); those args
 * are accepted for call-site compatibility and either ignored or answered with
 * an explicit "not in Kanon v1" note rather than a hard failure. Initiatives,
 * status updates, documents, and cycles ARE modelled (they live in
 * `other_entities`; see the handlers below).
 */

import type { EventActor } from "@kanon/core";
import type { KanonService } from "@kanon/service";
import { ServiceError } from "@kanon/service";
import {
  getIssue,
  listActors,
  listComments,
  listLabels,
  listStates,
  resolveCycles,
  resolveDocuments,
  resolveInitiatives,
  resolveProjects,
  resolveStatusUpdates,
  resolveTeams,
} from "@kanon/store";
import {
  formatAgentSession,
  formatAgentSessionList,
  formatCycle,
  formatCycleList,
  formatDocument,
  formatDocumentList,
  formatInitiative,
  formatInitiativeList,
  formatIssueDetail,
  formatIssueList,
  formatLabelList,
  formatProject,
  formatProjectList,
  formatStateList,
  formatStatusUpdate,
  formatStatusUpdateList,
  formatTeam,
  formatTeamList,
  formatUserList,
  type UserLine,
} from "./format";
import type { KanonToolName } from "./kanon-schemas";
import type { LinearToolName } from "./linear-schemas";

export interface ToolContext {
  service: KanonService;
  actor: EventActor;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => string;

export type ToolName = LinearToolName | KanonToolName;

// -- arg coercion -------------------------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ServiceError(400, `${key} must be a string`);
  return value;
}

/** Tri-state read for "Null to remove" args: null passes through as null. */
function strOrNull(args: Record<string, unknown>, key: string): string | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ServiceError(400, `${key} must be a string or null`);
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

/** Map Linear's "me" sentinel to the authenticated actor id (null passes through). */
function resolveMe(ref: string | null | undefined, actor: EventActor): string | null | undefined {
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
  const remove = (type: "blocks" | "blocked-by" | "related", targets: string[] | undefined) => {
    for (const target of targets ?? []) {
      const result = ctx.service.unrelate(ctx.actor, issueRef, { type, target });
      notes.push(result.removed ? `-${type} ${target}` : `${type} ${target} (no such relation)`);
    }
  };
  remove("blocks", strArray(args, "removeBlocks"));
  remove("blocked-by", strArray(args, "removeBlockedBy"));
  remove("related", strArray(args, "removeRelatedTo"));
  return notes;
}

// -- handlers -----------------------------------------------------------------

export const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
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
    // project / milestone / parent apply on BOTH create and update (updateIssue
    // resolves and writes them), so they live in the shared field set. The
    // "Null to remove" seats (assignee/delegate/project/milestone/parentId)
    // are tri-state: null flows through clean() (which drops only undefined)
    // into updateIssue, which clears the seat.
    const shared = clean({
      title: str(args, "title"),
      description: str(args, "description"),
      priority: typeof args.priority === "number" ? args.priority : undefined,
      estimate: typeof args.estimate === "number" ? args.estimate : undefined,
      state: str(args, "state"),
      assignee: resolveMe(strOrNull(args, "assignee"), ctx.actor),
      delegate: resolveMe(strOrNull(args, "delegate"), ctx.actor),
      project: strOrNull(args, "project"),
      milestone: strOrNull(args, "milestone"),
      parent: strOrNull(args, "parentId"),
      labels: strArray(args, "labels"),
    });
    let ref: string;
    if (id === undefined) {
      // Creating: a null seat means "leave empty" — drop nulls so
      // createIssue's optional readers see clean input.
      const createBody = Object.fromEntries(
        Object.entries(shared).filter(([, value]) => value !== null),
      );
      const created = ctx.service.createIssue(
        ctx.actor,
        clean({ ...createBody, team: requireStr(args, "team") }),
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
    const id = str(args, "id");
    const fields = clean({
      description: str(args, "description"),
      targetDate: strOrNull(args, "targetDate"),
      state: str(args, "state"),
      summary: str(args, "summary"),
      startDate: str(args, "startDate"),
    });
    const project =
      id === undefined
        ? ctx.service.createProject(ctx.actor, {
            ...fields,
            name: requireStr(args, "name"),
          })
        : ctx.service.updateProject(ctx.actor, id, clean({ ...fields, name: str(args, "name") }));
    if (project === null) throw new ServiceError(500, "project save returned no record");
    return formatProject(project);
  },

  list_initiatives(_args, ctx) {
    return formatInitiativeList(ctx.service.listInitiatives());
  },

  get_initiative(args, ctx) {
    const query = requireStr(args, "query");
    const initiative = resolveInitiatives(ctx.service.db, query)[0];
    if (initiative === undefined) {
      throw new ServiceError(404, `no initiative matching "${query}"`);
    }
    return formatInitiative(initiative);
  },

  save_initiative(args, ctx) {
    const id = str(args, "id");
    const fields = clean({
      description: str(args, "description"),
      summary: str(args, "summary"),
      status: str(args, "status"),
      owner: resolveMe(strOrNull(args, "owner"), ctx.actor),
      targetDate: strOrNull(args, "targetDate"),
      priority: typeof args.priority === "number" ? args.priority : undefined,
      color: str(args, "color"),
      icon: str(args, "icon"),
    });
    const initiative =
      id === undefined
        ? ctx.service.createInitiative(ctx.actor, { ...fields, name: requireStr(args, "name") })
        : ctx.service.updateInitiative(
            ctx.actor,
            id,
            clean({ ...fields, name: str(args, "name") }),
          );
    if (initiative === null) throw new ServiceError(500, "initiative save returned no record");
    return formatInitiative(initiative);
  },

  get_status_updates(args, ctx) {
    const id = str(args, "id");
    if (id !== undefined) {
      const update = resolveStatusUpdates(ctx.service.db, id)[0];
      if (update === undefined) throw new ServiceError(404, `no status update matching "${id}"`);
      return formatStatusUpdate(update);
    }
    const updates = ctx.service.listStatusUpdates({
      type: requireStr(args, "type"),
      project: str(args, "project"),
      initiative: str(args, "initiative"),
      authorId: resolveMe(str(args, "user"), ctx.actor) ?? undefined,
    });
    return formatStatusUpdateList(updates);
  },

  save_status_update(args, ctx) {
    const type = requireStr(args, "type");
    const id = str(args, "id");
    const fields = clean({ health: str(args, "health"), body: str(args, "body") });
    const update =
      id === undefined
        ? ctx.service.createStatusUpdate(ctx.actor, {
            ...fields,
            type,
            project: str(args, "project"),
            initiative: str(args, "initiative"),
          })
        : ctx.service.updateStatusUpdate(ctx.actor, id, fields);
    if (update === null) throw new ServiceError(500, "status update save returned no record");
    return formatStatusUpdate(update);
  },

  list_documents(args, ctx) {
    // Linear names the parent filters with an `Id` suffix; Kanon resolves refs.
    return formatDocumentList(
      ctx.service.listDocuments({
        project: str(args, "projectId"),
        initiative: str(args, "initiativeId"),
        team: str(args, "teamId"),
        creatorId: str(args, "creatorId"),
        query: str(args, "query"),
      }),
    );
  },

  get_document(args, ctx) {
    const id = requireStr(args, "id");
    const document = resolveDocuments(ctx.service.db, id)[0];
    if (document === undefined) throw new ServiceError(404, `no document matching "${id}"`);
    return formatDocument(document);
  },

  save_document(args, ctx) {
    const id = str(args, "id");
    // Parent refs apply on both create (exactly one required) and update (reparent).
    const fields = clean({
      title: str(args, "title"),
      content: str(args, "content"),
      color: str(args, "color"),
      icon: str(args, "icon"),
      project: str(args, "project"),
      issue: str(args, "issue"),
      initiative: str(args, "initiative"),
      cycle: str(args, "cycle"),
      team: str(args, "team"),
    });
    const document =
      id === undefined
        ? ctx.service.createDocument(ctx.actor, fields)
        : ctx.service.updateDocument(ctx.actor, id, fields);
    if (document === null) throw new ServiceError(500, "document save returned no record");
    return formatDocument(document);
  },

  list_comments(args, ctx) {
    const issue = getIssue(ctx.service.db, requireStr(args, "issueId"));
    if (issue === undefined)
      throw new ServiceError(404, `no issue matching "${requireStr(args, "issueId")}"`);
    const comments = listComments(ctx.service.db, issue.id);
    if (comments.length === 0) return `_No comments on ${issue.identifier ?? issue.id}._`;
    const lines = comments.map(
      (comment) =>
        `- ${comment.parentId === null ? "" : "↳ "}(${comment.createdAt}) ` +
        `${comment.actorId ?? "?"}: ${comment.body ?? ""} \`${comment.id}\``,
    );
    return `## Comments on ${issue.identifier ?? issue.id} (${comments.length})\n\n${lines.join("\n")}`;
  },

  save_comment(args, ctx) {
    const id = str(args, "id");
    if (id !== undefined) {
      const updated = ctx.service.updateComment(ctx.actor, id, {
        body: requireStr(args, "body"),
      });
      return `Updated comment \`${updated.id}\`.`;
    }
    const issueId = requireStr(args, "issueId");
    const result = ctx.service.comment(
      ctx.actor,
      issueId,
      clean({ body: requireStr(args, "body"), parentId: str(args, "parentId") }),
    );
    return result.parentId === undefined
      ? `Commented on ${issueId} (\`${result.id}\`).`
      : `Replied to \`${result.parentId}\` on ${issueId} (\`${result.id}\`).`;
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
    // teamId is resolved as a ref (name or id); `type` is a date-derived window.
    const cycles = ctx.service.listCycles({
      team: requireStr(args, "teamId"),
      type: str(args, "type"),
    });
    return formatCycleList(cycles);
  },

  get_cycle(args, ctx) {
    const id = requireStr(args, "id");
    const cycle = resolveCycles(ctx.service.db, id)[0];
    if (cycle === undefined) throw new ServiceError(404, `no cycle matching "${id}"`);
    return formatCycle(cycle);
  },

  save_cycle(args, ctx) {
    const id = str(args, "id");
    const fields = clean({
      name: str(args, "name"),
      number: typeof args.number === "number" ? args.number : undefined,
      startsAt: str(args, "startsAt"),
      endsAt: str(args, "endsAt"),
      description: str(args, "description"),
    });
    const cycle =
      id === undefined
        ? ctx.service.createCycle(ctx.actor, { ...fields, team: requireStr(args, "team") })
        : ctx.service.updateCycle(ctx.actor, id, fields);
    if (cycle === null) throw new ServiceError(500, "cycle save returned no record");
    return formatCycle(cycle);
  },

  // -- Kanon extensions: agent-session platform (M3 Phase 2) -------------------

  create_agent_session(args, ctx) {
    const result = ctx.service.createAgentSession(
      ctx.actor,
      clean({
        issue: requireStr(args, "issue"),
        agent: resolveMe(str(args, "agent"), ctx.actor),
        prompt: str(args, "prompt"),
      }),
    );
    if (result.session === null) {
      throw new ServiceError(500, "agent session create returned no record");
    }
    const detail = ctx.service.agentSessionDetail(result.session.id);
    return formatAgentSession(ctx.service.db, detail.session, detail.issue, detail.activities);
  },

  list_agent_sessions(args, ctx) {
    const sessions = ctx.service.agentSessions(
      clean({
        issue: str(args, "issue"),
        agent: resolveMe(str(args, "agent"), ctx.actor),
        state: str(args, "state"),
      }) as Record<string, string | undefined>,
    );
    return formatAgentSessionList(ctx.service.db, sessions);
  },

  get_agent_session(args, ctx) {
    const detail = ctx.service.agentSessionDetail(requireStr(args, "id"));
    return formatAgentSession(ctx.service.db, detail.session, detail.issue, detail.activities);
  },

  append_agent_activity(args, ctx) {
    const result = ctx.service.appendAgentActivity(ctx.actor, requireStr(args, "sessionId"), {
      type: requireStr(args, "type"),
      body: requireStr(args, "body"),
    });
    const state = result.session?.state ?? "?";
    return `Appended **${result.activity?.type ?? "?"}** to \`${requireStr(args, "sessionId")}\` — session is now **${state}**.`;
  },
};
