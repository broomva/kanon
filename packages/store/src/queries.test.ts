import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjection, type Projection } from "./projection";
import {
  findRelation,
  getIssue,
  getTeam,
  listComments,
  listIssues,
  listMilestones,
  listProjects,
  listRelations,
  listStates,
  listTeams,
  readyIssues,
  resolveActors,
  resolveLabels,
  resolveStates,
} from "./queries";
import { E, entityId, fixtureEvent, writeEvents, writeFixture } from "./testing";

let dir: string;
let projection: Projection;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kanon-queries-"));
  writeFixture(dir);
  projection = openProjection(dir);
  projection.refresh();
  db = projection.db;
});

afterAll(() => {
  projection.close();
  rmSync(dir, { recursive: true, force: true });
});

function numbers(issues: { number: number | null }[]): number[] {
  return issues.map((issue) => issue.number ?? -1).sort((a, b) => a - b);
}

describe("listIssues filter matrix", () => {
  test("no filters: all non-deleted issues, archived included by default", () => {
    expect(numbers(listIssues(db))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("includeDeleted surfaces tombstones", () => {
    expect(numbers(listIssues(db, { includeDeleted: true }))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("includeArchived: false hides archived issues", () => {
    expect(numbers(listIssues(db, { includeArchived: false }))).toEqual([1, 2, 3, 5, 6]);
  });

  test("team by key (case-insensitive) and by ULID", () => {
    expect(numbers(listIssues(db, { team: "bro" }))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(numbers(listIssues(db, { team: entityId(E.team) }))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(listIssues(db, { team: "NOPE" })).toEqual([]);
  });

  test("state by name, by state_type, and by ULID", () => {
    expect(numbers(listIssues(db, { state: "Todo" }))).toEqual([2, 5]);
    expect(numbers(listIssues(db, { state: "unstarted" }))).toEqual([2, 5]);
    expect(numbers(listIssues(db, { state: entityId(E.stateBacklog) }))).toEqual([3, 6]);
    expect(numbers(listIssues(db, { state: "completed" }))).toEqual([1, 4]);
  });

  test("assignee and delegate", () => {
    expect(numbers(listIssues(db, { assignee: entityId(E.actorCarlos) }))).toEqual([1]);
    expect(numbers(listIssues(db, { delegate: entityId(E.actorClaude) }))).toEqual([3]);
  });

  test("project and label (by name and by id)", () => {
    expect(numbers(listIssues(db, { project: entityId(E.project) }))).toEqual([1, 2]);
    expect(numbers(listIssues(db, { label: "Bug" }))).toEqual([2]);
    expect(numbers(listIssues(db, { label: entityId(E.labelFeature) }))).toEqual([1, 2]);
  });

  test("priority and parentId", () => {
    expect(numbers(listIssues(db, { priority: 2 }))).toEqual([2, 3]);
    expect(numbers(listIssues(db, { parentId: entityId(E.issueStore) }))).toEqual([3]);
  });

  test("updatedAfter / updatedBefore bound on updated_at", () => {
    expect(numbers(listIssues(db, { updatedAfter: "2026-07-01T00:00:00.000Z" }))).toEqual([5, 6]);
    expect(
      numbers(
        listIssues(db, {
          updatedBefore: "2026-06-13T23:59:59.000Z",
          updatedAfter: "2026-06-12T00:00:00.000Z",
        }),
      ),
    ).toEqual([2, 3]);
  });

  test("text query LIKE on title, case-insensitive, wildcards escaped", () => {
    expect(numbers(listIssues(db, { query: "sqlite" }))).toEqual([2]);
    expect(numbers(listIssues(db, { query: "100%" }))).toEqual([]);
  });

  test("orderBy + orderDir + limit + offset", () => {
    const desc = listIssues(db, { orderBy: "updatedAt", orderDir: "desc" });
    expect(desc[0]?.number).toBe(6);
    const page = listIssues(db, { orderBy: "createdAt", limit: 2, offset: 1 });
    expect(page.map((issue) => issue.number)).toEqual([2, 3]);
  });

  test("issue records carry sorted labelIds and parsed overflow data", () => {
    const store = listIssues(db, { query: "SQLite" })[0];
    expect(store?.labelIds).toEqual([entityId(E.labelFeature), entityId(E.labelBug)].sort());
    expect(store?.data.linearId).toBe("lin-x");
    expect(store?.identifier).toBe("BRO-2");
  });
});

describe("readyIssues", () => {
  test("backlog/unstarted, alive, and unblocked — blocked-by-open excluded, blocked-by-completed included", () => {
    const ready = numbers(readyIssues(db));
    expect(ready).toContain(2); // Todo, not blocked
    expect(ready).toContain(3); // Backlog
    expect(ready).toContain(6); // blocked only by a COMPLETED issue
    expect(ready).not.toContain(1); // Done — not a ready state
    expect(ready).not.toContain(4); // archived
    expect(ready).not.toContain(5); // blocked by open #2
    expect(ready).not.toContain(7); // deleted
  });

  test("team scoping and priority-first ordering", () => {
    const ready = readyIssues(db, "BRO");
    expect(ready.length).toBeGreaterThan(0);
    // priority 2 issues first, unprioritized (none) last
    const priorities = ready.map((issue) => issue.priority ?? 0);
    const nonZero = priorities.filter((priority) => priority > 0);
    expect(priorities.slice(0, nonZero.length)).toEqual(nonZero);
    expect(readyIssues(db, "NOPE")).toEqual([]);
  });

  test("unrelate unblocks: removing the blocks edge makes the issue ready", () => {
    const scratch = mkdtempSync(join(tmpdir(), "kanon-unrelate-"));
    try {
      const events = writeFixture(scratch);
      writeEvents(scratch, [
        fixtureEvent({
          seq: 95,
          op: "unrelate",
          model: "issue_relation",
          entity: E.relStoreBlocks5,
          ts: "2026-07-08T09:00:00.000Z",
        }),
      ]);
      expect(events.length).toBeGreaterThan(0);
      const scratchProjection = openProjection(scratch);
      scratchProjection.refresh();
      expect(numbers(readyIssues(scratchProjection.db))).toContain(5);
      scratchProjection.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("getIssue", () => {
  test("by ULID, by identifier, case-insensitive", () => {
    const byUlid = getIssue(db, entityId(E.issueStore));
    expect(byUlid?.number).toBe(2);
    expect(getIssue(db, "BRO-2")?.id).toBe(byUlid?.id);
    expect(getIssue(db, "bro-2")?.id).toBe(byUlid?.id);
    expect(getIssue(db, "BRO-999")).toBeUndefined();
    expect(getIssue(db, "not a ref")).toBeUndefined();
  });
});

describe("minimal list/get surfaces", () => {
  test("teams", () => {
    expect(listTeams(db).map((team) => team.key)).toEqual(["BRO"]);
    expect(getTeam(db, "bro")?.name).toBe("Broomva");
    expect(getTeam(db, "Broomva")?.key).toBe("BRO");
  });

  test("states ordered by position; resolution id → type → name", () => {
    const states = listStates(db, entityId(E.team));
    expect(states.map((state) => state.name)).toEqual([
      "Triage",
      "Backlog",
      "Todo",
      "In Progress",
      "Done",
      "Canceled",
      "Duplicate",
    ]);
    expect(resolveStates(db, "canceled").map((state) => state.name)).toEqual([
      "Canceled",
      "Duplicate",
    ]);
    expect(resolveStates(db, "duplicate")[0]?.name).toBe("Duplicate");
    expect(resolveStates(db, entityId(E.stateTodo))[0]?.name).toBe("Todo");
  });

  test("actors resolve by email then name then display name", () => {
    expect(resolveActors(db, "carlos@example.com")[0]?.name).toBe("Carlos");
    expect(resolveActors(db, "claude")[0]?.email).toBe("claude@example.com");
    expect(resolveActors(db, "claude-agent")[0]?.actorType).toBe("agent");
    expect(resolveActors(db, "nobody")).toEqual([]);
  });

  test("labels, projects, milestones", () => {
    expect(resolveLabels(db, "bug")[0]?.color).toBe("#eb5757");
    expect(listProjects(db).map((project) => project.name)).toEqual(["Kanon"]);
    expect(listMilestones(db, entityId(E.project)).map((milestone) => milestone.name)).toEqual([
      "M1",
    ]);
  });

  test("comments by issue in creation order; relations from either side", () => {
    const comments = listComments(db, entityId(E.issueStore));
    expect(comments.map((comment) => comment.body)).toEqual([
      "Needs rebuild-idempotence tests.",
      "Added to the plan.",
    ]);
    expect(comments[1]?.parentId).toBe(entityId(E.comment1));

    const fromBlocker = listRelations(db, entityId(E.issueStore));
    const fromBlocked = listRelations(db, entityId(E.issueBlockedOpen));
    expect(fromBlocker.map((relation) => relation.relType)).toContain("blocks");
    expect(fromBlocked.map((relation) => relation.id)).toContain(entityId(E.relStoreBlocks5));

    expect(
      findRelation(db, "blocks", entityId(E.issueStore), entityId(E.issueBlockedOpen))?.id,
    ).toBe(entityId(E.relStoreBlocks5));
    expect(
      findRelation(db, "blocks", entityId(E.issueBlockedOpen), entityId(E.issueStore)),
    ).toBeUndefined();
  });
});
