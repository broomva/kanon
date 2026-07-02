/**
 * Live Linear → LinearExport snapshot via @linear/sdk.
 *
 * Thin and defensive by design: this module talks to the network and is NOT
 * covered by unit tests. Everything downstream (transform, data-repo) is pure
 * and fixture-tested; `--save-export` captures a live pull once so it can be
 * re-run offline as a fixture.
 *
 * Pagination: 50 nodes/page with a brief delay between pages to stay well
 * inside Linear's rate limits. Cross-entity reference ids are read from the
 * SDK's internal `_<field>.id` backing fields (via refId, defensively) so we
 * never pay one lazy-fetch request per reference.
 */

import { LinearClient } from "@linear/sdk";
import { compact } from "./transform";
import type {
  LinearCommentExport,
  LinearExport,
  LinearInitiativeExport,
  LinearIssueExport,
  LinearLabelExport,
  LinearMilestoneExport,
  LinearProjectExport,
  LinearRelationExport,
  LinearTeamExport,
  LinearUserExport,
} from "./types";

const PAGE_SIZE = 50;
const PAGE_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

async function allPages<T>(fetchPage: (after: string | undefined) => Promise<Page<T>>) {
  const nodes: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetchPage(after);
    nodes.push(...page.nodes);
    const cursor = page.pageInfo.endCursor;
    if (!page.pageInfo.hasNextPage || typeof cursor !== "string") return nodes;
    after = cursor;
    await sleep(PAGE_DELAY_MS);
  }
}

function pageArgs(after: string | undefined): { first: number; after?: string } {
  return { first: PAGE_SIZE, ...(after === undefined ? {} : { after }) };
}

/** Defensive read of the SDK's private `_<field>.id` reference backing store. */
function refId(entity: unknown, field: string): string | undefined {
  if (typeof entity !== "object" || entity === null) return undefined;
  const raw = (entity as Record<string, unknown>)[`_${field}`];
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function iso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return undefined;
}

/** TimelessDate fields arrive as YYYY-MM-DD strings; pass them through. */
function dateish(value: unknown): string | undefined {
  return typeof value === "string" ? value : iso(value);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "linear-import";
}

/** compact + cast: optional export fields are simply absent when unknown. */
function toExport<T>(data: Record<string, unknown>): T {
  return compact(data) as T;
}

export async function fetchLinearExport(): Promise<LinearExport> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("--live requires the LINEAR_API_KEY environment variable");
  }
  const client = new LinearClient({ apiKey });

  const organization = await client.organization;
  const workspace = slugify(organization.urlKey || organization.name);

  // teams + workflow states
  const teams: LinearTeamExport[] = [];
  for (const team of await allPages((after) => client.teams(pageArgs(after)))) {
    const states = await allPages((after) => team.states(pageArgs(after)));
    teams.push({
      linearId: team.id,
      key: team.key,
      name: team.name,
      states: states.map((state) => ({
        linearId: state.id,
        name: state.name,
        type: state.type,
        color: state.color,
        position: state.position,
      })),
    });
  }

  // labels
  const labels = (await allPages((after) => client.issueLabels(pageArgs(after)))).map((label) =>
    toExport<LinearLabelExport>({
      linearId: label.id,
      name: label.name,
      color: label.color,
      teamLinearId: refId(label, "team"),
    }),
  );

  // users (Linear marks app/agent actors on the user object; read defensively)
  const users = (await allPages((after) => client.users(pageArgs(after)))).map((user) =>
    toExport<LinearUserExport>({
      linearId: user.id,
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      isAgent: (user as { app?: boolean }).app === true ? true : undefined,
    }),
  );

  // projects + milestones (milestones hang off projects in the API);
  // includeArchived so issues inside archived projects keep their linkage
  const projects: LinearProjectExport[] = [];
  const milestones: LinearMilestoneExport[] = [];
  for (const project of await allPages((after) =>
    client.projects({ ...pageArgs(after), includeArchived: true }),
  )) {
    let teamLinearIds: string[] = [];
    try {
      teamLinearIds = (await allPages((after) => project.teams(pageArgs(after)))).map((t) => t.id);
    } catch {
      // team linkage is best-effort
    }
    try {
      for (const milestone of await allPages((after) =>
        project.projectMilestones(pageArgs(after)),
      )) {
        milestones.push(
          toExport<LinearMilestoneExport>({
            linearId: milestone.id,
            projectLinearId: project.id,
            name: milestone.name,
            targetDate: dateish(milestone.targetDate),
          }),
        );
      }
    } catch {
      // milestones are best-effort
    }
    projects.push(
      toExport<LinearProjectExport>({
        linearId: project.id,
        name: project.name,
        description: project.description,
        state: (project as { state?: string }).state,
        leadLinearId: refId(project, "lead"),
        targetDate: dateish(project.targetDate),
        teamLinearIds,
      }),
    );
  }

  // initiatives (plan-gated on some workspaces — best-effort)
  let initiatives: LinearInitiativeExport[] = [];
  try {
    initiatives = (await allPages((after) => client.initiatives(pageArgs(after)))).map(
      (initiative) =>
        toExport<LinearInitiativeExport>({
          linearId: initiative.id,
          name: initiative.name,
          description: initiative.description,
          targetDate: dateish((initiative as { targetDate?: unknown }).targetDate),
        }),
    );
  } catch {
    // proceed without initiatives
  }

  // relations, fetched globally and grouped per issue
  const relationsByIssue = new Map<string, LinearRelationExport[]>();
  try {
    for (const relation of await allPages((after) => client.issueRelations(pageArgs(after)))) {
      const issueLinearId = refId(relation, "issue");
      const relatedLinearId = refId(relation, "relatedIssue");
      if (issueLinearId === undefined || relatedLinearId === undefined) continue;
      const list = relationsByIssue.get(issueLinearId) ?? [];
      list.push({ type: String(relation.type), relatedIssueLinearId: relatedLinearId });
      relationsByIssue.set(issueLinearId, list);
    }
  } catch {
    // relations are best-effort
  }

  // issues, including archived
  const issues = (
    await allPages((after) => client.issues({ ...pageArgs(after), includeArchived: true }))
  ).map((issue) =>
    toExport<LinearIssueExport>({
      linearId: issue.id,
      teamLinearId: refId(issue, "team"),
      number: issue.number,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      estimate: issue.estimate,
      stateLinearId: refId(issue, "state"),
      assigneeLinearId: refId(issue, "assignee"),
      parentLinearId: refId(issue, "parent"),
      projectLinearId: refId(issue, "project"),
      milestoneLinearId: refId(issue, "projectMilestone"),
      labelLinearIds: (issue as { labelIds?: string[] }).labelIds ?? [],
      createdAt: iso(issue.createdAt),
      updatedAt: iso(issue.updatedAt),
      archivedAt: iso(issue.archivedAt),
      relations: relationsByIssue.get(issue.id) ?? [],
    }),
  );

  // comments, fetched globally (one paginated query instead of one per issue)
  const comments = (await allPages((after) => client.comments(pageArgs(after)))).flatMap(
    (comment) => {
      const issueLinearId = refId(comment, "issue");
      if (issueLinearId === undefined) return [];
      return [
        toExport<LinearCommentExport>({
          linearId: comment.id,
          issueLinearId,
          body: comment.body,
          userLinearId: refId(comment, "user"),
          parentLinearId: refId(comment, "parent"),
          createdAt: iso(comment.createdAt),
        }),
      ];
    },
  );

  return { workspace, teams, labels, users, projects, milestones, initiatives, issues, comments };
}
