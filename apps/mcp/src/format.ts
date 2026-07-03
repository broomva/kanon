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
