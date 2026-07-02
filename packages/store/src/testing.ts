/**
 * Test-only fixture builder for the projection suites. Not exported from
 * index.ts. Deterministic ids follow the same scheme as @kanon/core's
 * testing helper: fixed-width Crockford-base32 encodings of a sequence
 * number, so "higher seq" always means "later in ULID total order".
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createEvent,
  type EventActor,
  type KanonEvent,
  type Model,
  type Op,
  segmentName,
  serializeEvent,
} from "@kanon/core";

export const TEST_ACTOR: EventActor = { type: "agent", id: "test-agent", surface: "cli" };
export const WORKSPACE = "test";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LENGTH = 26;

/** Deterministic ULID-shaped id, lexicographically ordered by `n` (n >= 0). */
export function testId(n: number): string {
  let out = "";
  let t = n;
  for (let i = 0; i < ID_LENGTH; i++) {
    out = ENCODING.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Entity-pool member `i` as a modelId (offset keeps it clear of event ids). */
export function entityId(i: number): string {
  return testId(1_000_000 + i);
}

export interface FixtureEventSpec {
  /** Unique per event; determines the id and hence the total order. */
  seq: number;
  op: Op;
  model: Model;
  /** Index into the shared entity-id pool. */
  entity: number;
  data?: Record<string, unknown>;
  /** ISO timestamp — controls segment routing and entity updatedAt. */
  ts: string;
}

export function fixtureEvent(spec: FixtureEventSpec): KanonEvent {
  return createEvent({
    workspace: WORKSPACE,
    actor: TEST_ACTOR,
    op: spec.op,
    model: spec.model,
    modelId: entityId(spec.entity),
    data: spec.data ?? {},
    id: testId(spec.seq),
    ts: spec.ts,
  });
}

/** Append events to a data repo dir's monthly segments (appendFileSync semantics). */
export function writeEvents(dir: string, events: KanonEvent[]): void {
  mkdirSync(join(dir, "events"), { recursive: true });
  for (const event of events) {
    appendFileSync(join(dir, "events", segmentName(event.ts)), `${serializeEvent(event)}\n`);
  }
}

// ---------------------------------------------------------------------------
// The reference fixture: one team, 7 states, labels, actors, project,
// milestone, issues with parent/labels/relations, comments. Entity pool
// indices are stable so tests can reference entities by name.
// ---------------------------------------------------------------------------

export const E = {
  team: 0,
  stateTriage: 1,
  stateBacklog: 2,
  stateTodo: 3,
  stateInProgress: 4,
  stateDone: 5,
  stateCanceled: 6,
  stateDuplicate: 7,
  labelBug: 8,
  labelFeature: 9,
  actorCarlos: 10,
  actorClaude: 11,
  project: 12,
  milestone: 13,
  issueCore: 20, // #1 — Done, assignee carlos, [Feature], priority 1
  issueStore: 21, // #2 — Todo, [Feature, Bug], priority 2, overflow fields
  issueCli: 22, // #3 — Backlog, parent #2, delegate claude, priority 2
  issueArchived: 23, // #4 — Done + archived
  issueBlockedOpen: 24, // #5 — Todo, blocked by open #2
  issueBlockedDone: 25, // #6 — Backlog, blocked by completed #1
  issueDeleted: 26, // #7 — deleted tombstone
  relStoreBlocks5: 30, // #2 blocks #5
  relCoreBlocks6: 31, // #1 blocks #6
  comment1: 32,
  comment2: 33,
} as const;

const JUNE = "2026-06-10T10:00:00.000Z";

function state(
  seq: number,
  entity: number,
  name: string,
  type: string,
  position: number,
): FixtureEventSpec {
  return {
    seq,
    op: "create",
    model: "workflow_state",
    entity,
    ts: JUNE,
    data: { teamId: entityId(E.team), name, type, color: "#888888", position },
  };
}

function issue(
  seq: number,
  entity: number,
  number: number,
  title: string,
  stateEntity: number,
  ts: string,
  extra: Record<string, unknown> = {},
): FixtureEventSpec {
  return {
    seq,
    op: "create",
    model: "issue",
    entity,
    ts,
    data: {
      teamId: entityId(E.team),
      number,
      title,
      stateId: entityId(stateEntity),
      ...extra,
    },
  };
}

/** The reference event stream, in seq order. Spans two monthly segments. */
export function fixtureSpecs(): FixtureEventSpec[] {
  return [
    { seq: 1, op: "create", model: "workspace", entity: 99, ts: JUNE, data: { slug: WORKSPACE } },
    {
      seq: 2,
      op: "create",
      model: "team",
      entity: E.team,
      ts: JUNE,
      data: { key: "BRO", name: "Broomva" },
    },
    state(3, E.stateTriage, "Triage", "triage", 0),
    state(4, E.stateBacklog, "Backlog", "backlog", 1),
    state(5, E.stateTodo, "Todo", "unstarted", 2),
    state(6, E.stateInProgress, "In Progress", "started", 3),
    state(7, E.stateDone, "Done", "completed", 4),
    state(8, E.stateCanceled, "Canceled", "canceled", 5),
    state(9, E.stateDuplicate, "Duplicate", "canceled", 6),
    {
      seq: 10,
      op: "create",
      model: "label",
      entity: E.labelBug,
      ts: JUNE,
      data: { teamId: entityId(E.team), name: "Bug", color: "#eb5757" },
    },
    {
      seq: 11,
      op: "create",
      model: "label",
      entity: E.labelFeature,
      ts: JUNE,
      data: { teamId: entityId(E.team), name: "Feature", color: "#bb87fc" },
    },
    {
      seq: 12,
      op: "create",
      model: "actor",
      entity: E.actorCarlos,
      ts: JUNE,
      data: {
        name: "Carlos",
        displayName: "broomva",
        email: "carlos@example.com",
        actorType: "human",
      },
    },
    {
      seq: 13,
      op: "create",
      model: "actor",
      entity: E.actorClaude,
      ts: JUNE,
      data: {
        name: "Claude",
        displayName: "claude-agent",
        email: "claude@example.com",
        actorType: "agent",
      },
    },
    {
      seq: 14,
      op: "create",
      model: "project",
      entity: E.project,
      ts: JUNE,
      data: { name: "Kanon", description: "Agent-native tracker", state: "started" },
    },
    {
      seq: 15,
      op: "create",
      model: "milestone",
      entity: E.milestone,
      ts: JUNE,
      data: { projectId: entityId(E.project), name: "M1" },
    },
    issue(20, E.issueCore, 1, "Core merge and replay", E.stateDone, "2026-06-11T09:00:00.000Z", {
      assigneeId: entityId(E.actorCarlos),
      labelIds: [entityId(E.labelFeature)],
      priority: 1,
      projectId: entityId(E.project),
    }),
    issue(21, E.issueStore, 2, "SQLite projection", E.stateTodo, "2026-06-12T09:00:00.000Z", {
      labelIds: [entityId(E.labelFeature), entityId(E.labelBug)],
      priority: 2,
      estimate: 3,
      projectId: entityId(E.project),
      milestoneId: entityId(E.milestone),
      linearId: "lin-x",
      weird: { nested: true, list: [1, 2] },
    }),
    issue(22, E.issueCli, 3, "CLI lifecycle", E.stateBacklog, "2026-06-13T09:00:00.000Z", {
      parentId: entityId(E.issueStore),
      delegateId: entityId(E.actorClaude),
      priority: 2,
    }),
    issue(23, E.issueArchived, 4, "Archived spike", E.stateDone, "2026-06-14T09:00:00.000Z"),
    {
      seq: 24,
      op: "archive",
      model: "issue",
      entity: E.issueArchived,
      ts: "2026-06-15T09:00:00.000Z",
    },
    issue(25, E.issueBlockedOpen, 5, "Blocked by open", E.stateTodo, "2026-07-01T09:00:00.000Z"),
    issue(
      26,
      E.issueBlockedDone,
      6,
      "Blocked by completed",
      E.stateBacklog,
      "2026-07-02T09:00:00.000Z",
    ),
    issue(27, E.issueDeleted, 7, "Deleted issue", E.stateTodo, "2026-07-03T09:00:00.000Z"),
    {
      seq: 28,
      op: "delete",
      model: "issue",
      entity: E.issueDeleted,
      ts: "2026-07-03T10:00:00.000Z",
    },
    {
      seq: 30,
      op: "relate",
      model: "issue_relation",
      entity: E.relStoreBlocks5,
      ts: "2026-07-04T09:00:00.000Z",
      data: {
        type: "blocks",
        issueId: entityId(E.issueStore),
        relatedIssueId: entityId(E.issueBlockedOpen),
      },
    },
    {
      seq: 31,
      op: "relate",
      model: "issue_relation",
      entity: E.relCoreBlocks6,
      ts: "2026-07-04T09:05:00.000Z",
      data: {
        type: "blocks",
        issueId: entityId(E.issueCore),
        relatedIssueId: entityId(E.issueBlockedDone),
      },
    },
    {
      seq: 32,
      op: "create",
      model: "comment",
      entity: E.comment1,
      ts: "2026-07-05T09:00:00.000Z",
      data: {
        issueId: entityId(E.issueStore),
        body: "Needs rebuild-idempotence tests.",
        actorId: entityId(E.actorCarlos),
      },
    },
    {
      seq: 33,
      op: "create",
      model: "comment",
      entity: E.comment2,
      ts: "2026-07-05T10:00:00.000Z",
      data: {
        issueId: entityId(E.issueStore),
        body: "Added to the plan.",
        actorId: entityId(E.actorClaude),
        parentId: entityId(E.comment1),
      },
    },
    // An imported model with no dedicated table — must survive in other_entities.
    {
      seq: 34,
      op: "create",
      model: "initiative",
      entity: 40,
      ts: "2026-07-06T09:00:00.000Z",
      data: { name: "Agent OS", description: "umbrella" },
    },
  ];
}

export function fixtureEvents(): KanonEvent[] {
  return fixtureSpecs().map(fixtureEvent);
}

/** Write the reference fixture into a data repo dir. */
export function writeFixture(dir: string): KanonEvent[] {
  const events = fixtureEvents();
  writeEvents(dir, events);
  return events;
}
