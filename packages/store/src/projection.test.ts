import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeEvent } from "@kanon/core";
import { loadLog } from "./log";
import { openProjection, projectionChecksum } from "./projection";
import { getIssue } from "./queries";
import { E, entityId, fixtureEvent, testId, writeFixture } from "./testing";

const dirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanon-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("openProjection", () => {
  test("rebuild is idempotent: two rebuilds produce identical content", () => {
    const dir = tempRepo();
    writeFixture(dir);
    const projection = openProjection(dir);
    projection.rebuild();
    const first = projectionChecksum(projection.db);
    projection.rebuild();
    const second = projectionChecksum(projection.db);
    expect(second).toBe(first);
    projection.close();
  });

  test("the cache is disposable: delete state.db, rebuild, identical content", () => {
    const dir = tempRepo();
    writeFixture(dir);
    const projection = openProjection(dir);
    projection.rebuild();
    const before = projectionChecksum(projection.db);
    projection.close();

    unlinkSync(join(dir, "state.db"));
    const fresh = openProjection(dir);
    fresh.refresh();
    expect(projectionChecksum(fresh.db)).toBe(before);
    fresh.close();
  });

  test("refresh no-ops when the log is unchanged and rebuilds when an event lands", () => {
    const dir = tempRepo();
    writeFixture(dir);
    const projection = openProjection(dir);

    const initial = projection.refresh();
    expect(initial.rebuilt).toBe(true);
    const again = projection.refresh();
    expect(again.rebuilt).toBe(false);
    expect(again.eventCount).toBe(initial.eventCount);

    // A new event lands (newer ULID routed into an OLD month segment — the
    // import pattern; segments are routing, never immutable).
    const late = fixtureEvent({
      seq: 90,
      op: "create",
      model: "issue",
      entity: 60,
      ts: "2026-06-20T09:00:00.000Z",
      data: { teamId: entityId(E.team), number: 8, title: "Late arrival" },
    });
    appendFileSync(join(dir, "events", "2026-06.jsonl"), `${serializeEvent(late)}\n`);

    const after = projection.refresh();
    expect(after.rebuilt).toBe(true);
    expect(after.eventCount).toBe(initial.eventCount + 1);
    expect(getIssue(projection.db, "BRO-8")?.title).toBe("Late arrival");
    projection.close();
  });

  test("unknown data fields survive into data_json", () => {
    const dir = tempRepo();
    writeFixture(dir);
    const projection = openProjection(dir);
    projection.refresh();

    const issue = getIssue(projection.db, entityId(E.issueStore));
    expect(issue).toBeDefined();
    expect(issue?.data.linearId).toBe("lin-x");
    expect(issue?.data.weird).toEqual({ nested: true, list: [1, 2] });
    // Typed fields are NOT duplicated into the overflow.
    expect(issue?.data.title).toBeUndefined();
    expect(issue?.data.labelIds).toBeUndefined();
    projection.close();
  });

  test("models without a dedicated table land in other_entities", () => {
    const dir = tempRepo();
    writeFixture(dir);
    const projection = openProjection(dir);
    projection.refresh();

    const row = projection.db
      .query<{ model: string; data_json: string }, [string]>(
        "SELECT model, data_json FROM other_entities WHERE id = ?",
      )
      .get(entityId(40));
    expect(row?.model).toBe("initiative");
    expect(JSON.parse(row?.data_json ?? "{}")).toEqual({
      name: "Agent OS",
      description: "umbrella",
    });
    projection.close();
  });

  test("identifier column is team.key || '-' || number, NULL when either is missing", () => {
    const dir = tempRepo();
    writeFixture(dir);
    // An issue with a number but no team: identifier must be NULL.
    const orphan = fixtureEvent({
      seq: 91,
      op: "create",
      model: "issue",
      entity: 61,
      ts: "2026-07-07T09:00:00.000Z",
      data: { number: 999, title: "No team" },
    });
    appendFileSync(join(dir, "events", "2026-07.jsonl"), `${serializeEvent(orphan)}\n`);

    const projection = openProjection(dir);
    projection.refresh();
    expect(getIssue(projection.db, entityId(E.issueStore))?.identifier).toBe("BRO-2");
    expect(getIssue(projection.db, entityId(61))?.identifier).toBeNull();
    projection.close();
  });

  test("same-count/same-head CONTENT change still rebuilds (content hash)", () => {
    const dir = tempRepo();
    writeFixture(dir);
    const projection = openProjection(dir, { onWarn: () => {} });
    projection.refresh();
    expect(projection.refresh().rebuilt).toBe(false); // baseline: up to date

    // Byzantine duplicate of a MID-STREAM event (not the head) with content
    // engineered to WIN the merge tie-break (smaller canonical
    // serialization). Dedupe keeps the merged COUNT unchanged and the HEAD
    // id unchanged — only the canonical CONTENT of the stream moved.
    const conflicting = fixtureEvent({
      seq: 21, // collides with the issueStore create
      op: "create",
      model: "issue",
      entity: E.issueStore,
      ts: "2026-06-12T09:00:00.000Z",
      data: { number: 2, title: "AAA" },
    });
    appendFileSync(join(dir, "events", "2026-06.jsonl"), `${serializeEvent(conflicting)}\n`);

    const report = loadLog(dir);
    expect(report.conflicts.length).toBe(1);
    const winner = report.events.find((event) => event.id === testId(21));

    const result = projection.refresh();
    expect(result.rebuilt).toBe(true); // head/count alone would have missed this
    // The projection reflects the tie-break winner, byte-identical to a
    // forced rebuild from the canonical stream.
    const afterRefresh = projectionChecksum(projection.db);
    expect(getIssue(projection.db, entityId(E.issueStore))?.title).toBe(
      winner?.data.title as string,
    );
    projection.rebuild();
    expect(projectionChecksum(projection.db)).toBe(afterRefresh);
    projection.close();
  });

  test("merge conflicts WARN and the build proceeds with the tie-broken stream", () => {
    const dir = tempRepo();
    writeFixture(dir);
    // Same event id, different content, in a DIFFERENT segment file — a
    // misbehaving producer. The union merge tie-breaks deterministically.
    const conflicting = fixtureEvent({
      seq: 21, // collides with the issueStore create
      op: "create",
      model: "issue",
      entity: E.issueStore,
      ts: "2026-08-01T09:00:00.000Z",
      data: { teamId: entityId(E.team), number: 2, title: "Conflicting duplicate" },
    });
    appendFileSync(join(dir, "events", "2026-08.jsonl"), `${serializeEvent(conflicting)}\n`);

    const warnings: string[] = [];
    const projection = openProjection(dir, { onWarn: (message) => warnings.push(message) });
    const result = projection.refresh();
    expect(result.rebuilt).toBe(true);
    expect(result.conflictCount).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(testId(21));
    // The projection still answers queries from the canonical stream.
    expect(getIssue(projection.db, entityId(E.issueStore))).toBeDefined();
    projection.close();
  });

  test("an empty data repo builds an empty projection", () => {
    const dir = tempRepo();
    const projection = openProjection(dir);
    const result = projection.refresh();
    expect(result.rebuilt).toBe(true);
    expect(result.eventCount).toBe(0);
    expect(result.headId).toBeNull();
    expect(projection.refresh().rebuilt).toBe(false);
    projection.close();
  });
});
