/**
 * Markdown response formatting — the MCP tools return human/agent-readable
 * markdown, the same register the real linear-server replies in (an agent
 * reads "**BRO-12** Title — In Progress", not raw JSON). Formatters resolve
 * ULIDs to display names against the projection so responses reference
 * `BRO-12`, `In Progress`, `carlos@…`, never bare ULIDs.
 */

import type { Database } from "bun:sqlite";
import {
  type AgentActivityRecord,
  type AgentSessionRecord,
  type BaseRecord,
  type CommentRecord,
  getIssue,
  type IssueRecord,
  type LabelRecord,
  listStates,
  type ProjectRecord,
  type RelationRecord,
  resolveActors,
  resolveLabels,
  resolveProjects,
  resolveStates,
  resolveTeams,
  type StateRecord,
  type TeamRecord,
} from "@kanon/store";

const PRIORITIES = ["None", "Urgent", "High", "Medium", "Low"] as const;

export function priorityLabel(priority: number | null): string {
  if (priority === null || priority < 0 || priority > 4) return "None";
  return PRIORITIES[priority] ?? "None";
}

function stateName(db: Database, stateId: string | null): string {
  if (stateId === null) return "—";
  const state = resolveStates(db, stateId)[0];
  return state?.name ?? stateId;
}

function actorName(db: Database, actorId: string | null): string | null {
  if (actorId === null) return null;
  const actor = resolveActors(db, actorId)[0];
  return actor?.displayName ?? actor?.name ?? actor?.email ?? actorId;
}

function projectName(db: Database, projectId: string | null): string | null {
  if (projectId === null) return null;
  return resolveProjects(db, projectId)[0]?.name ?? projectId;
}

/** One-line issue summary for lists. */
export function issueLine(db: Database, issue: IssueRecord): string {
  const ref = issue.identifier ?? issue.id;
  const archived = issue.archivedAt === null ? "" : " _(archived)_";
  return `- **${ref}** ${issue.title ?? ""} — ${stateName(db, issue.stateId)} · ${priorityLabel(issue.priority)}${archived}`;
}

export function formatIssueList(db: Database, issues: IssueRecord[], heading: string): string {
  if (issues.length === 0) return `${heading}\n\n_No issues._`;
  return `${heading} (${issues.length})\n\n${issues.map((issue) => issueLine(db, issue)).join("\n")}`;
}

export function formatIssueDetail(
  db: Database,
  issue: IssueRecord,
  comments: CommentRecord[],
  relations: RelationRecord[],
): string {
  const ref = issue.identifier ?? issue.id;
  const lines = [`# ${ref} — ${issue.title ?? ""}`, ""];
  lines.push(`- **Status**: ${stateName(db, issue.stateId)}`);
  lines.push(`- **Priority**: ${priorityLabel(issue.priority)}`);
  const assignee = actorName(db, issue.assigneeId);
  if (assignee !== null) lines.push(`- **Assignee**: ${assignee}`);
  const delegate = actorName(db, issue.delegateId);
  if (delegate !== null) lines.push(`- **Delegate**: ${delegate}`);
  const project = projectName(db, issue.projectId);
  if (project !== null) lines.push(`- **Project**: ${project}`);
  if (issue.estimate !== null) lines.push(`- **Estimate**: ${issue.estimate}`);
  if (issue.labelIds.length > 0) {
    const names = issue.labelIds.map((id) => resolveLabels(db, id)[0]?.name ?? id);
    lines.push(`- **Labels**: ${names.join(", ")}`);
  }
  if (issue.parentId !== null) {
    lines.push(`- **Parent**: ${resolveIdentifier(db, issue.parentId)}`);
  }
  if (issue.archivedAt !== null) lines.push(`- **Archived**: ${issue.archivedAt}`);
  lines.push(`- **ID**: ${issue.id}`);
  lines.push(`- **Created**: ${issue.createdAt} · **Updated**: ${issue.updatedAt}`);
  if (issue.description !== null && issue.description.length > 0) {
    lines.push("", "## Description", "", issue.description);
  }
  if (relations.length > 0) {
    lines.push("", "## Relations");
    for (const relation of relations) {
      if (relation.relType === "blocks") {
        const line =
          relation.issueId === issue.id
            ? `blocks ${resolveIdentifier(db, relation.relatedIssueId)}`
            : `blocked by ${resolveIdentifier(db, relation.issueId)}`;
        lines.push(`- ${line}`);
      } else {
        const other = relation.issueId === issue.id ? relation.relatedIssueId : relation.issueId;
        lines.push(`- ${relation.relType ?? "related"} ${resolveIdentifier(db, other)}`);
      }
    }
  }
  if (comments.length > 0) {
    lines.push("", `## Comments (${comments.length})`);
    for (const comment of comments) {
      lines.push(
        `- **${actorName(db, comment.actorId) ?? "?"}** (${comment.createdAt}): ${comment.body ?? ""}`,
      );
    }
  }
  return lines.join("\n");
}

function resolveIdentifier(db: Database, issueId: string | null): string {
  if (issueId === null) return "—";
  return getIssue(db, issueId)?.identifier ?? issueId;
}

export function formatTeamList(teams: TeamRecord[]): string {
  if (teams.length === 0) return "_No teams._";
  return `## Teams (${teams.length})\n\n${teams
    .map((team) => `- **${team.key ?? "??"}** ${team.name ?? ""} — \`${team.id}\``)
    .join("\n")}`;
}

export function formatTeam(db: Database, team: TeamRecord): string {
  const states = listStates(db, team.id);
  return [
    `# ${team.key ?? "??"} — ${team.name ?? ""}`,
    `- **ID**: ${team.id}`,
    `- **Workflow states**: ${states.map((s) => `${s.name} (${s.stateType})`).join(", ")}`,
  ].join("\n");
}

export function formatProjectList(projects: ProjectRecord[]): string {
  if (projects.length === 0) return "_No projects._";
  return `## Projects (${projects.length})\n\n${projects
    .map(
      (project) =>
        `- **${project.name ?? "(unnamed)"}** — ${project.state ?? "—"} \`${project.id}\``,
    )
    .join("\n")}`;
}

export function formatProject(project: ProjectRecord): string {
  const lines = [`# ${project.name ?? "(unnamed)"}`, `- **ID**: ${project.id}`];
  if (project.state !== null) lines.push(`- **State**: ${project.state}`);
  if (project.targetDate !== null) lines.push(`- **Target date**: ${project.targetDate}`);
  if (project.description !== null && project.description.length > 0) {
    lines.push("", project.description);
  }
  return lines.join("\n");
}

// Initiatives live in other_entities, so their fields ride the `data` overflow.
export function formatInitiativeList(initiatives: BaseRecord[]): string {
  if (initiatives.length === 0) return "_No initiatives._";
  return `## Initiatives (${initiatives.length})\n\n${initiatives
    .map(
      (init) =>
        `- **${String(init.data.name ?? "(unnamed)")}** — ${String(init.data.status ?? "—")} \`${init.id}\``,
    )
    .join("\n")}`;
}
export function formatInitiative(initiative: BaseRecord): string {
  const d = initiative.data;
  const lines = [`# ${String(d.name ?? "(unnamed)")}`, `- **ID**: ${initiative.id}`];
  if (d.status != null) lines.push(`- **Status**: ${String(d.status)}`);
  if (d.targetDate != null) lines.push(`- **Target date**: ${String(d.targetDate)}`);
  if (typeof d.description === "string" && d.description.length > 0) {
    lines.push("", d.description);
  }
  return lines.join("\n");
}

// Status updates also live in other_entities — health/body/parent ride `data`.
export function formatStatusUpdateList(updates: BaseRecord[]): string {
  if (updates.length === 0) return "_No status updates._";
  return `## Status updates (${updates.length})\n\n${updates
    .map((u) => {
      const parent = String(u.data.projectId ?? u.data.initiativeId ?? "—");
      return `- **${String(u.data.health ?? "—")}** — ${String(u.data.type ?? "—")} \`${parent}\` \`${u.id}\``;
    })
    .join("\n")}`;
}
export function formatStatusUpdate(update: BaseRecord): string {
  const d = update.data;
  const lines = [
    "# Status update",
    `- **ID**: ${update.id}`,
    `- **Type**: ${String(d.type ?? "—")}`,
  ];
  const parent = d.projectId ?? d.initiativeId;
  if (parent != null) lines.push(`- **Parent**: ${String(parent)}`);
  if (d.health != null) lines.push(`- **Health**: ${String(d.health)}`);
  if (d.authorId != null) lines.push(`- **Author**: ${String(d.authorId)}`);
  if (typeof d.body === "string" && d.body.length > 0) lines.push("", d.body);
  return lines.join("\n");
}

// Documents also live in other_entities — title/content/parent ride `data`.
function documentParent(d: Record<string, unknown>): string {
  const type = d.parentType;
  const id = d.projectId ?? d.issueId ?? d.initiativeId ?? d.cycleId ?? d.teamId;
  return id == null ? "—" : `${type != null ? `${String(type)} ` : ""}${String(id)}`;
}
export function formatDocumentList(documents: BaseRecord[]): string {
  if (documents.length === 0) return "_No documents._";
  return `## Documents (${documents.length})\n\n${documents
    .map(
      (doc) =>
        `- **${String(doc.data.title ?? "(untitled)")}** — ${documentParent(doc.data)} \`${doc.id}\``,
    )
    .join("\n")}`;
}
export function formatDocument(document: BaseRecord): string {
  const d = document.data;
  const lines = [`# ${String(d.title ?? "(untitled)")}`, `- **ID**: ${document.id}`];
  lines.push(`- **Parent**: ${documentParent(d)}`);
  if (d.creatorId != null) lines.push(`- **Creator**: ${String(d.creatorId)}`);
  if (typeof d.content === "string" && d.content.length > 0) lines.push("", d.content);
  return lines.join("\n");
}

// Cycles also live in other_entities — team/number/dates ride `data`.
function cycleLabel(d: Record<string, unknown>): string {
  if (d.name != null) return String(d.name);
  if (d.number != null) return `Cycle ${String(d.number)}`;
  return "(unnamed cycle)";
}
export function formatCycleList(cycles: BaseRecord[]): string {
  if (cycles.length === 0) return "_No cycles._";
  return `## Cycles (${cycles.length})\n\n${cycles
    .map((c) => {
      const window =
        c.data.startsAt != null && c.data.endsAt != null
          ? ` (${String(c.data.startsAt)} → ${String(c.data.endsAt)})`
          : "";
      return `- **${cycleLabel(c.data)}**${window} \`${c.id}\``;
    })
    .join("\n")}`;
}
export function formatCycle(cycle: BaseRecord): string {
  const d = cycle.data;
  const lines = [`# ${cycleLabel(d)}`, `- **ID**: ${cycle.id}`];
  if (d.teamId != null) lines.push(`- **Team**: ${String(d.teamId)}`);
  if (d.number != null) lines.push(`- **Number**: ${String(d.number)}`);
  if (d.startsAt != null) lines.push(`- **Starts**: ${String(d.startsAt)}`);
  if (d.endsAt != null) lines.push(`- **Ends**: ${String(d.endsAt)}`);
  if (typeof d.description === "string" && d.description.length > 0) lines.push("", d.description);
  return lines.join("\n");
}

// Saved views also live in other_entities — a name + the stored filter fields.
const SAVED_VIEW_FILTER_KEYS = [
  "team",
  "state",
  "assignee",
  "project",
  "label",
  "priority",
  "query",
];
function savedViewFilterSummary(d: Record<string, unknown>): string {
  const parts = SAVED_VIEW_FILTER_KEYS.filter((k) => d[k] != null).map(
    (k) => `${k}=${String(d[k])}`,
  );
  return parts.length === 0 ? "_no filters_" : parts.join(", ");
}
export function formatSavedViewList(views: BaseRecord[]): string {
  if (views.length === 0) return "_No saved views._";
  return `## Saved views (${views.length})\n\n${views
    .map(
      (v) =>
        `- **${String(v.data.name ?? "(unnamed)")}** — ${savedViewFilterSummary(v.data)} \`${v.id}\``,
    )
    .join("\n")}`;
}
export function formatSavedView(view: BaseRecord): string {
  const d = view.data;
  const lines = [`# ${String(d.name ?? "(unnamed)")}`, `- **ID**: ${view.id}`];
  lines.push(`- **Filter**: ${savedViewFilterSummary(d)}`);
  if (typeof d.description === "string" && d.description.length > 0) lines.push("", d.description);
  return lines.join("\n");
}

export function formatStateList(states: StateRecord[]): string {
  if (states.length === 0) return "_No statuses._";
  return `## Statuses (${states.length})\n\n${states
    .map(
      (state) =>
        `- **${state.name ?? "?"}** — type \`${state.stateType ?? "?"}\` (position ${state.position ?? "?"})`,
    )
    .join("\n")}`;
}

export function formatLabelList(labels: LabelRecord[]): string {
  if (labels.length === 0) return "_No labels._";
  return `## Labels (${labels.length})\n\n${labels
    .map((label) => `- **${label.name ?? "?"}** \`${label.id}\``)
    .join("\n")}`;
}

export interface UserLine {
  id: string;
  name: string | null;
  displayName: string | null;
  email: string | null;
  actorType: string | null;
}

export function formatUserList(users: UserLine[]): string {
  if (users.length === 0) return "_No users._";
  return `## Users (${users.length})\n\n${users
    .map(
      (user) =>
        `- **${user.displayName ?? user.name ?? "?"}** ${user.email ?? ""} — ${user.actorType ?? "?"} \`${user.id}\``,
    )
    .join("\n")}`;
}

/** Confirmation line after a write. */
export function formatSaved(kind: string, ref: string, id: string): string {
  return `Saved ${kind} **${ref}** (\`${id}\`).`;
}

/** One-line session summary: issue, agent, state. */
export function agentSessionLine(db: Database, session: AgentSessionRecord): string {
  const issue = session.issueId === null ? "—" : resolveIdentifier(db, session.issueId);
  const agent = actorName(db, session.actorId) ?? "?";
  return `- \`${session.id}\` **${issue}** → ${agent} — **${session.state ?? "?"}** (updated ${session.updatedAt})`;
}

export function formatAgentSessionList(db: Database, sessions: AgentSessionRecord[]): string {
  if (sessions.length === 0) return "_No agent sessions._";
  return `## Agent sessions (${sessions.length})\n\n${sessions
    .map((session) => agentSessionLine(db, session))
    .join("\n")}`;
}

export function formatAgentSession(
  db: Database,
  session: AgentSessionRecord,
  issue: IssueRecord | null,
  activities: AgentActivityRecord[],
): string {
  const issueRef = issue === null ? (session.issueId ?? "—") : (issue.identifier ?? issue.id);
  const lines = [
    `# Agent session \`${session.id}\``,
    "",
    `- **Issue**: ${issueRef}${issue?.title ? ` — ${issue.title}` : ""}`,
    `- **Agent**: ${actorName(db, session.actorId) ?? "?"}`,
    `- **State**: ${session.state ?? "?"}`,
    `- **Created**: ${session.createdAt} · **Updated**: ${session.updatedAt}`,
  ];
  if (activities.length > 0) {
    lines.push("", `## Timeline (${activities.length})`, "");
    for (const activity of activities) {
      lines.push(`- **${activity.type ?? "?"}** (${activity.createdAt}): ${activity.body ?? ""}`);
    }
  }
  return lines.join("\n");
}

// Re-export the resolvers a handler may need for team/project lookups.
export { resolveProjects, resolveTeams };
