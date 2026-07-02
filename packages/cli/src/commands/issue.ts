/**
 * `kanon issue ...` — the issue lifecycle.
 *
 * Every write is createEvent → appendEvents → projection.refresh().
 * References resolve deterministically (ULID → identifier → exact
 * case-insensitive name; ambiguity errors with candidates).
 *
 * Relation direction convention (matches the Linear importer):
 * `{rel_type: 'blocks', issue_id: A, related_issue_id: B}` means A BLOCKS B.
 */

import type { Database } from "bun:sqlite";
import { ulid } from "@kanon/core";
import {
  findRelation,
  getIssue,
  type IssueRecord,
  listComments,
  listIssues,
  listRelations,
  listStates,
  readyIssues,
  resolveActors,
  resolveLabels,
  resolveStates,
} from "@kanon/store";
import { resolveActor } from "../actor";
import {
  CliError,
  type FlagValue,
  flagBool,
  flagInt,
  flagNumber,
  flagString,
  flagStrings,
  parseFlags,
  requireFlag,
} from "../args";
import {
  allocateDisplayNumber,
  compact,
  type EventInput,
  openRepo,
  type RepoContext,
  writeEvents,
} from "../context";
import { emit, priorityLabel } from "../output";
import {
  findLabel,
  requireActor,
  requireIssue,
  requireLabel,
  requireMilestone,
  requireProject,
  requireState,
  requireTeam,
} from "../refs";

const COMMON = { json: "boolean", repo: "value" } as const;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * The current CLI actor as an actor ENTITY id — resolved when one exists,
 * minted otherwise (so assignee/delegate always reference actor ULIDs, same
 * as imported history). Returns the id plus the mint event when needed.
 */
function actorEntity(ctx: RepoContext): { id: string; mint?: EventInput } {
  const matches = resolveActors(ctx.projection.db, ctx.actor.id);
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) {
    return { id: first.id };
  }
  if (matches.length > 1) {
    throw new CliError(
      `current actor "${ctx.actor.id}" matches ${matches.length} actor entities — ` +
        `set KANON_ACTOR to one ULID of: ${matches.map((match) => match.id).join(", ")}`,
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
        name: ctx.actor.id,
        actorType: ctx.actor.type,
        email: ctx.actor.id.includes("@") ? ctx.actor.id : undefined,
      }),
    },
  };
}

/** Resolve a label to an id, minting a team-scoped label when none matches. */
function labelEntity(
  ctx: RepoContext,
  teamId: string | null,
  ref: string,
  mints: EventInput[],
): string {
  const existing = findLabel(ctx.projection.db, ref);
  if (existing !== undefined) return existing.id;
  const id = ulid();
  mints.push({
    op: "create",
    model: "label",
    modelId: id,
    data: compact({ name: ref, teamId: teamId ?? undefined }),
  });
  return id;
}

/** Default state for new issues: backlog → unstarted → lowest position. */
function defaultStateId(ctx: RepoContext, teamId: string): string | undefined {
  const states = listStates(ctx.projection.db, teamId);
  const byType = (type: string) => states.find((state) => state.stateType === type);
  return (byType("backlog") ?? byType("unstarted") ?? states[0])?.id;
}

function identifierOf(db: Database, issueId: string | null): string | null {
  if (issueId === null) return null;
  const issue = getIssue(db, issueId);
  return issue?.identifier ?? issueId;
}

function issueLine(db: Database, issue: IssueRecord): string {
  const state = issue.stateId === null ? undefined : resolveStates(db, issue.stateId)[0]?.name;
  const archived = issue.archivedAt === null ? "" : "  [archived]";
  return `${issue.identifier ?? issue.id}  ${state ?? "?"}  ${priorityLabel(issue.priority)}  ${
    issue.title ?? ""
  }${archived}`;
}

function printIssues(db: Database, issues: IssueRecord[]): void {
  if (issues.length === 0) {
    console.log("no issues");
    return;
  }
  for (const issue of issues) {
    console.log(issueLine(db, issue));
  }
}

// ---------------------------------------------------------------------------
// issue create
// ---------------------------------------------------------------------------

export function issueCreate(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    {
      ...COMMON,
      team: "value",
      title: "value",
      description: "value",
      priority: "value",
      estimate: "value",
      assignee: "value",
      delegate: "value",
      project: "value",
      milestone: "value",
      parent: "value",
      label: "repeated",
    },
    { min: 0, max: 0, usage: "kanon issue create --team BRO --title ..." },
  );
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;
  const team = requireTeam(db, requireFlag(flags, "team"));
  const title = requireFlag(flags, "title");
  if (team.key === null) {
    throw new CliError(`team ${team.id} has no key — cannot allocate a display number`);
  }

  const projectFlag = flagString(flags, "project");
  const project = projectFlag === undefined ? undefined : requireProject(db, projectFlag);
  const milestoneFlag = flagString(flags, "milestone");
  const milestone =
    milestoneFlag === undefined ? undefined : requireMilestone(db, milestoneFlag, project?.id);
  const assigneeFlag = flagString(flags, "assignee");
  const delegateFlag = flagString(flags, "delegate");
  const parentFlag = flagString(flags, "parent");

  const mints: EventInput[] = [];
  const labelIds = flagStrings(flags, "label").map((ref) => labelEntity(ctx, team.id, ref, mints));

  const number = allocateDisplayNumber(ctx, team.id, team.key);
  const data = compact({
    teamId: team.id,
    number,
    title,
    description: flagString(flags, "description"),
    priority: flagInt(flags, "priority", 0, 4),
    estimate: flagNumber(flags, "estimate"),
    stateId: defaultStateId(ctx, team.id),
    assigneeId: assigneeFlag === undefined ? undefined : requireActor(db, assigneeFlag).id,
    delegateId: delegateFlag === undefined ? undefined : requireActor(db, delegateFlag).id,
    parentId: parentFlag === undefined ? undefined : requireIssue(db, parentFlag).id,
    projectId: project?.id,
    milestoneId: milestone?.id,
    labelIds: labelIds.length > 0 ? labelIds : undefined,
  });

  const issueId = ulid();
  writeEvents(ctx, [...mints, { op: "create", model: "issue", modelId: issueId, data }]);

  const identifier = `${team.key}-${number}`;
  emit(flagBool(flags, "json"), { id: issueId, identifier, number, title }, () => {
    console.log(`created ${identifier} — ${title} (${issueId})`);
  });
  ctx.projection.close();
}

// ---------------------------------------------------------------------------
// issue show
// ---------------------------------------------------------------------------

export function issueShow(argv: string[]): void {
  const { positionals, flags } = parseFlags(argv, COMMON, {
    min: 1,
    max: 1,
    usage: "kanon issue show <ref>",
  });
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;
  const ref = positionals[0];
  if (ref === undefined) throw new CliError("issue show requires a <ref>");
  const issue = requireIssue(db, ref);

  const state = issue.stateId === null ? undefined : resolveStates(db, issue.stateId)[0];
  const comments = listComments(db, issue.id);
  const relations = listRelations(db, issue.id).map((relation) => ({
    ...relation,
    issueIdentifier: identifierOf(db, relation.issueId),
    relatedIssueIdentifier: identifierOf(db, relation.relatedIssueId),
  }));

  emit(flagBool(flags, "json"), { issue, state: state ?? null, comments, relations }, () => {
    console.log(`${issue.identifier ?? issue.id}  ${issue.title ?? ""}`);
    console.log(`  id:        ${issue.id}`);
    console.log(`  state:     ${state?.name ?? "?"} (${state?.stateType ?? "?"})`);
    console.log(`  priority:  ${priorityLabel(issue.priority)}`);
    if (issue.estimate !== null) console.log(`  estimate:  ${issue.estimate}`);
    if (issue.assigneeId !== null) console.log(`  assignee:  ${issue.assigneeId}`);
    if (issue.delegateId !== null) console.log(`  delegate:  ${issue.delegateId}`);
    if (issue.parentId !== null) console.log(`  parent:    ${identifierOf(db, issue.parentId)}`);
    if (issue.labelIds.length > 0) {
      const names = issue.labelIds.map((labelId) => resolveLabels(db, labelId)[0]?.name ?? labelId);
      console.log(`  labels:    ${names.join(", ")}`);
    }
    if (issue.archivedAt !== null) console.log(`  archived:  ${issue.archivedAt}`);
    if (issue.deleted) console.log("  deleted:   true");
    console.log(`  created:   ${issue.createdAt}   updated: ${issue.updatedAt}`);
    if (issue.description !== null) console.log(`\n${issue.description}`);
    if (relations.length > 0) {
      console.log("\nrelations:");
      for (const relation of relations) {
        if (relation.relType === "blocks") {
          const line =
            relation.issueId === issue.id
              ? `blocks ${relation.relatedIssueIdentifier}`
              : `blocked by ${relation.issueIdentifier}`;
          console.log(`  ${line}`);
        } else {
          const other =
            relation.issueId === issue.id
              ? relation.relatedIssueIdentifier
              : relation.issueIdentifier;
          console.log(`  ${relation.relType ?? "related"} ${other}`);
        }
      }
    }
    if (comments.length > 0) {
      console.log(`\ncomments (${comments.length}):`);
      for (const comment of comments) {
        console.log(`  [${comment.createdAt}] ${comment.actorId ?? "?"}: ${comment.body ?? ""}`);
      }
    }
  });
  ctx.projection.close();
}

// ---------------------------------------------------------------------------
// issue list + ready
// ---------------------------------------------------------------------------

export function issueList(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    {
      ...COMMON,
      team: "value",
      state: "value",
      assignee: "value",
      delegate: "value",
      project: "value",
      label: "value",
      priority: "value",
      parent: "value",
      "updated-after": "value",
      "updated-before": "value",
      query: "value",
      "no-archived": "boolean",
      "order-by": "value",
      "order-dir": "value",
      limit: "value",
      offset: "value",
    },
    { min: 0, max: 0, usage: "kanon issue list [filters]" },
  );
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;

  const orderBy = flagString(flags, "order-by");
  if (orderBy !== undefined && orderBy !== "createdAt" && orderBy !== "updatedAt") {
    throw new CliError("--order-by must be createdAt or updatedAt");
  }
  const orderDir = flagString(flags, "order-dir");
  if (orderDir !== undefined && orderDir !== "asc" && orderDir !== "desc") {
    throw new CliError("--order-dir must be asc or desc");
  }
  const assigneeFlag = flagString(flags, "assignee");
  const delegateFlag = flagString(flags, "delegate");
  const projectFlag = flagString(flags, "project");
  const parentFlag = flagString(flags, "parent");

  const issues = listIssues(db, {
    ...(flagString(flags, "team") !== undefined && { team: flagString(flags, "team") as string }),
    ...(flagString(flags, "state") !== undefined && {
      state: flagString(flags, "state") as string,
    }),
    ...(assigneeFlag !== undefined && { assignee: requireActor(db, assigneeFlag).id }),
    ...(delegateFlag !== undefined && { delegate: requireActor(db, delegateFlag).id }),
    ...(projectFlag !== undefined && { project: requireProject(db, projectFlag).id }),
    ...(flagString(flags, "label") !== undefined && {
      label: requireLabel(db, flagString(flags, "label") as string).id,
    }),
    ...(flagInt(flags, "priority", 0, 4) !== undefined && {
      priority: flagInt(flags, "priority", 0, 4) as number,
    }),
    ...(parentFlag !== undefined && { parentId: requireIssue(db, parentFlag).id }),
    ...(flagString(flags, "updated-after") !== undefined && {
      updatedAfter: flagString(flags, "updated-after") as string,
    }),
    ...(flagString(flags, "updated-before") !== undefined && {
      updatedBefore: flagString(flags, "updated-before") as string,
    }),
    ...(flagString(flags, "query") !== undefined && {
      query: flagString(flags, "query") as string,
    }),
    ...(flagBool(flags, "no-archived") && { includeArchived: false }),
    ...(orderBy !== undefined && { orderBy }),
    ...(orderDir !== undefined && { orderDir }),
    ...(flagInt(flags, "limit", 1, 1_000_000) !== undefined && {
      limit: flagInt(flags, "limit", 1, 1_000_000) as number,
    }),
    ...(flagInt(flags, "offset", 0, 1_000_000_000) !== undefined && {
      offset: flagInt(flags, "offset", 0, 1_000_000_000) as number,
    }),
  });

  emit(flagBool(flags, "json"), issues, () => printIssues(db, issues));
  ctx.projection.close();
}

export function issueReady(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { ...COMMON, team: "value" },
    { min: 0, max: 0, usage: "kanon issue ready [--team BRO]" },
  );
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;
  const team = flagString(flags, "team");
  const issues = team === undefined ? readyIssues(db) : readyIssues(db, requireTeam(db, team).id);
  emit(flagBool(flags, "json"), issues, () => printIssues(db, issues));
  ctx.projection.close();
}

// ---------------------------------------------------------------------------
// issue update / claim / archive
// ---------------------------------------------------------------------------

export function issueUpdate(argv: string[]): void {
  const { positionals, flags } = parseFlags(
    argv,
    {
      ...COMMON,
      state: "value",
      title: "value",
      description: "value",
      priority: "value",
      estimate: "value",
      assignee: "value",
      delegate: "value",
      "add-label": "repeated",
      "remove-label": "repeated",
    },
    { min: 1, max: 1, usage: "kanon issue update <ref> [--state ... --title ...]" },
  );
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;
  const ref = positionals[0];
  if (ref === undefined) throw new CliError("issue update requires a <ref>");
  const issue = requireIssue(db, ref);

  const mints: EventInput[] = [];
  const stateFlag = flagString(flags, "state");
  const assigneeFlag = flagString(flags, "assignee");
  const delegateFlag = flagString(flags, "delegate");

  let labelIds: string[] | undefined;
  const addLabels = flagStrings(flags, "add-label");
  const removeLabels = flagStrings(flags, "remove-label");
  if (addLabels.length > 0 || removeLabels.length > 0) {
    const next = new Set(issue.labelIds);
    for (const labelRef of addLabels) {
      next.add(labelEntity(ctx, issue.teamId, labelRef, mints));
    }
    for (const labelRef of removeLabels) {
      const label = requireLabel(db, labelRef);
      if (!next.delete(label.id)) {
        throw new CliError(`${issue.identifier ?? issue.id} does not carry label "${labelRef}"`);
      }
    }
    labelIds = [...next].sort();
  }

  const data = compact({
    stateId:
      stateFlag === undefined ? undefined : requireState(db, stateFlag, issue.teamId ?? "").id,
    title: flagString(flags, "title"),
    description: flagString(flags, "description"),
    priority: flagInt(flags, "priority", 0, 4),
    estimate: flagNumber(flags, "estimate"),
    assigneeId: assigneeFlag === undefined ? undefined : requireActor(db, assigneeFlag).id,
    delegateId: delegateFlag === undefined ? undefined : requireActor(db, delegateFlag).id,
    labelIds,
  });
  if (Object.keys(data).length === 0) {
    throw new CliError("issue update requires at least one field flag");
  }

  writeEvents(ctx, [...mints, { op: "update", model: "issue", modelId: issue.id, data }]);
  const updated = getIssue(db, issue.id);
  emit(flagBool(flags, "json"), updated, () => {
    console.log(`updated ${issue.identifier ?? issue.id}: ${Object.keys(data).join(", ")}`);
  });
  ctx.projection.close();
}

export function issueClaim(argv: string[]): void {
  const { positionals, flags } = parseFlags(argv, COMMON, {
    min: 1,
    max: 1,
    usage: "kanon issue claim <ref>",
  });
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;
  const ref = positionals[0];
  if (ref === undefined) throw new CliError("issue claim requires a <ref>");
  const issue = requireIssue(db, ref);

  const { id: actorId, mint } = actorEntity(ctx);
  // Claim rule: agents take the DELEGATE seat (the accountable human keeps
  // assignee); humans take assignee.
  const seat = ctx.actor.type === "agent" ? "delegateId" : "assigneeId";

  // Move to a started-type state unless the issue is already in one. When a
  // team has several started states, the lowest-position one wins.
  const currentType =
    issue.stateId === null ? undefined : resolveStates(db, issue.stateId)[0]?.stateType;
  let stateId: string | undefined;
  if (currentType !== "started" && issue.teamId !== null) {
    stateId = resolveStates(db, "started", issue.teamId)[0]?.id;
  }

  const data = compact({ [seat]: actorId, stateId });
  writeEvents(ctx, [
    ...(mint === undefined ? [] : [mint]),
    { op: "update", model: "issue", modelId: issue.id, data },
  ]);

  const updated = getIssue(db, issue.id);
  emit(flagBool(flags, "json"), updated, () => {
    console.log(
      `claimed ${issue.identifier ?? issue.id} as ${seat === "delegateId" ? "delegate" : "assignee"} ` +
        `${ctx.actor.id}${stateId === undefined ? "" : " (state → started)"}`,
    );
  });
  ctx.projection.close();
}

export function issueArchive(argv: string[]): void {
  const { positionals, flags } = parseFlags(argv, COMMON, {
    min: 1,
    max: 1,
    usage: "kanon issue archive <ref>",
  });
  const ctx = openRepo(flags, resolveActor());
  const ref = positionals[0];
  if (ref === undefined) throw new CliError("issue archive requires a <ref>");
  const issue = requireIssue(ctx.projection.db, ref);
  writeEvents(ctx, [{ op: "archive", model: "issue", modelId: issue.id, data: {} }]);
  const updated = getIssue(ctx.projection.db, issue.id);
  emit(flagBool(flags, "json"), updated, () => {
    console.log(`archived ${issue.identifier ?? issue.id}`);
  });
  ctx.projection.close();
}

// ---------------------------------------------------------------------------
// issue comment
// ---------------------------------------------------------------------------

export function issueComment(argv: string[]): void {
  const { positionals, flags } = parseFlags(
    argv,
    { ...COMMON, body: "value" },
    { min: 1, max: 1, usage: "kanon issue comment <ref> --body ..." },
  );
  const ctx = openRepo(flags, resolveActor());
  const ref = positionals[0];
  if (ref === undefined) throw new CliError("issue comment requires a <ref>");
  const issue = requireIssue(ctx.projection.db, ref);
  const body = requireFlag(flags, "body");
  const { id: actorId, mint } = actorEntity(ctx);
  const commentId = ulid();
  writeEvents(ctx, [
    ...(mint === undefined ? [] : [mint]),
    {
      op: "create",
      model: "comment",
      modelId: commentId,
      data: { issueId: issue.id, body, actorId },
    },
  ]);
  emit(flagBool(flags, "json"), { id: commentId, issueId: issue.id, body, actorId }, () => {
    console.log(`commented on ${issue.identifier ?? issue.id} (${commentId})`);
  });
  ctx.projection.close();
}

// ---------------------------------------------------------------------------
// issue relate / unrelate
// ---------------------------------------------------------------------------

interface RelationSpec {
  relType: "blocks" | "related";
  issueId: string;
  relatedIssueId: string;
}

/**
 * Normalize the relate/unrelate flags into a directed relation row:
 *   A --blocks B      → {blocks, issue_id: A, related_issue_id: B}
 *   A --blocked-by B  → {blocks, issue_id: B, related_issue_id: A}
 *   A --related-to B  → {related, issue_id: A, related_issue_id: B}
 */
function relationSpec(
  db: Database,
  issue: IssueRecord,
  flags: Map<string, FlagValue>,
): RelationSpec {
  const blocks = flagString(flags, "blocks");
  const blockedBy = flagString(flags, "blocked-by");
  const relatedTo = flagString(flags, "related-to");
  const given = [blocks, blockedBy, relatedTo].filter((value) => value !== undefined);
  if (given.length !== 1) {
    throw new CliError("provide exactly one of --blocks, --blocked-by, --related-to");
  }
  if (blocks !== undefined) {
    return { relType: "blocks", issueId: issue.id, relatedIssueId: requireIssue(db, blocks).id };
  }
  if (blockedBy !== undefined) {
    return {
      relType: "blocks",
      issueId: requireIssue(db, blockedBy).id,
      relatedIssueId: issue.id,
    };
  }
  return {
    relType: "related",
    issueId: issue.id,
    relatedIssueId: requireIssue(db, relatedTo as string).id,
  };
}

const RELATE_FLAGS = {
  ...COMMON,
  blocks: "value",
  "blocked-by": "value",
  "related-to": "value",
} as const;

function findExisting(db: Database, spec: RelationSpec) {
  const exact = findRelation(db, spec.relType, spec.issueId, spec.relatedIssueId);
  if (exact !== undefined || spec.relType === "blocks") return exact;
  // `related` is symmetric — either stored direction is the same edge.
  return findRelation(db, spec.relType, spec.relatedIssueId, spec.issueId);
}

export function issueRelate(argv: string[]): void {
  const { positionals, flags } = parseFlags(argv, RELATE_FLAGS, {
    min: 1,
    max: 1,
    usage: "kanon issue relate <ref> --blocks <ref2> | --blocked-by <ref2> | --related-to <ref2>",
  });
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;
  const ref = positionals[0];
  if (ref === undefined) throw new CliError("issue relate requires a <ref>");
  const issue = requireIssue(db, ref);
  const spec = relationSpec(db, issue, flags);
  if (spec.issueId === spec.relatedIssueId) {
    throw new CliError("an issue cannot relate to itself");
  }

  const existing = findExisting(db, spec);
  if (existing !== undefined) {
    emit(flagBool(flags, "json"), existing, () => {
      console.log(`relation already exists (${existing.id}) — nothing to do`);
    });
    ctx.projection.close();
    return;
  }

  const relationId = ulid();
  writeEvents(ctx, [
    {
      op: "relate",
      model: "issue_relation",
      modelId: relationId,
      data: { type: spec.relType, issueId: spec.issueId, relatedIssueId: spec.relatedIssueId },
    },
  ]);
  emit(flagBool(flags, "json"), { id: relationId, ...spec }, () => {
    console.log(
      `related: ${identifierOf(db, spec.issueId)} ${spec.relType} ${identifierOf(db, spec.relatedIssueId)}`,
    );
  });
  ctx.projection.close();
}

export function issueUnrelate(argv: string[]): void {
  const { positionals, flags } = parseFlags(argv, RELATE_FLAGS, {
    min: 1,
    max: 1,
    usage: "kanon issue unrelate <ref> --blocks <ref2> | --blocked-by <ref2> | --related-to <ref2>",
  });
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;
  const ref = positionals[0];
  if (ref === undefined) throw new CliError("issue unrelate requires a <ref>");
  const issue = requireIssue(db, ref);
  const spec = relationSpec(db, issue, flags);

  const existing = findExisting(db, spec);
  if (existing === undefined) {
    throw new CliError(
      `no ${spec.relType} relation between ${identifierOf(db, spec.issueId)} and ` +
        `${identifierOf(db, spec.relatedIssueId)}`,
    );
  }
  writeEvents(ctx, [{ op: "unrelate", model: "issue_relation", modelId: existing.id, data: {} }]);
  emit(flagBool(flags, "json"), { removed: existing.id }, () => {
    console.log(`unrelated (${existing.id})`);
  });
  ctx.projection.close();
}
