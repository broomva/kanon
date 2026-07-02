import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, segmentName } from "@kanon/core";
import fixtureJson from "../fixtures/export.small.json";
import { appendEvents, buildIdMap, loadEvents, seedDisplayCounters } from "./data-repo";
import { IMPORT_ACTOR, transform } from "./transform";
import type { LinearExport } from "./types";

const fixture = fixtureJson as unknown as LinearExport;

const tempDirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanon-linear-import-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("data-repo round-trip", () => {
  test("appendEvents → loadEvents → buildIdMap → transform is a fixed point", () => {
    const dir = tempRepo();
    const first = transform(structuredClone(fixture), new Map());
    appendEvents(dir, first.events);

    const loaded = loadEvents(dir);
    expect(loaded.length).toBe(first.events.length);
    // loadEvents returns ULID order == emission order for a single run
    expect(loaded.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
    expect(loaded).toEqual(first.events);

    const map = buildIdMap(loaded);
    expect(map.size).toBe(21); // every entity incl. the synthetic relation key
    expect(map.get("lin-issue-1643")?.archived).toBe(true); // archive op folded back

    const second = transform(structuredClone(fixture), map);
    expect(second.events).toEqual([]);
    expect(second.summary.skipped).toBe(21);
  });

  test("events land in monthly segments matching segmentName(ts)", () => {
    const dir = tempRepo();
    const { events } = transform(structuredClone(fixture), new Map());
    appendEvents(dir, events);

    const segments = readdirSync(join(dir, "events")).sort();
    const expected = [...new Set(events.map((e) => segmentName(e.ts)))].sort();
    expect(segments).toEqual(expected);
    // fixture issues/comments are June 2026; watermark-less entities use "now"
    expect(segments).toContain("2026-06.jsonl");
    expect(segments).toContain(segmentName(new Date().toISOString()));
  });

  test("appendEvents appends to existing segments instead of overwriting", () => {
    const dir = tempRepo();
    const base = {
      workspace: "broomva",
      actor: IMPORT_ACTOR,
      op: "create",
      model: "issue",
    } as const;
    const a = createEvent({ ...base, data: { linearId: "a" }, ts: "2026-06-01T00:00:00.000Z" });
    const b = createEvent({ ...base, data: { linearId: "b" }, ts: "2026-06-15T00:00:00.000Z" });
    appendEvents(dir, [a]);
    appendEvents(dir, [b]);
    expect(loadEvents(dir).map((e) => e.id)).toEqual([a.id, b.id]);
  });

  test("loadEvents returns [] for a repo with no events directory", () => {
    const dir = tempRepo();
    expect(loadEvents(dir)).toEqual([]);
  });
});

describe("buildIdMap", () => {
  test("tracks linearUpdatedAt watermarks and never clobbers them with archive events", () => {
    const base = {
      workspace: "broomva",
      actor: IMPORT_ACTOR,
      model: "issue",
    } as const;
    const create = createEvent({
      ...base,
      op: "create",
      data: { linearId: "lin-x", linearUpdatedAt: "2026-06-01T00:00:00.000Z" },
    });
    const archive = createEvent({
      ...base,
      op: "archive",
      modelId: create.modelId,
      data: { linearId: "lin-x" },
    });
    const update = createEvent({
      ...base,
      op: "update",
      modelId: create.modelId,
      data: { linearId: "lin-x", linearUpdatedAt: "2026-06-09T00:00:00.000Z" },
    });
    const unarchive = createEvent({
      ...base,
      op: "unarchive",
      modelId: create.modelId,
      data: { linearId: "lin-x" },
    });

    const afterArchive = buildIdMap([create, archive]);
    expect(afterArchive.get("lin-x")).toEqual({
      modelId: create.modelId,
      updatedAt: "2026-06-01T00:00:00.000Z",
      archived: true,
    });

    const afterUpdate = buildIdMap([create, archive, update]);
    expect(afterUpdate.get("lin-x")).toEqual({
      modelId: create.modelId,
      updatedAt: "2026-06-09T00:00:00.000Z",
      archived: true,
    });

    // the last archive/unarchive op wins as the archival state
    const afterUnarchive = buildIdMap([create, archive, update, unarchive]);
    expect(afterUnarchive.get("lin-x")).toEqual({
      modelId: create.modelId,
      updatedAt: "2026-06-09T00:00:00.000Z",
      archived: false,
    });
  });

  test("ignores events whose data has no linearId", () => {
    const event = createEvent({
      workspace: "broomva",
      actor: IMPORT_ACTOR,
      op: "create",
      model: "workspace",
      data: { slug: "broomva" },
    });
    expect(buildIdMap([event]).size).toBe(0);
  });
});

describe("seedDisplayCounters", () => {
  function writeMeta(dir: string, meta: Record<string, unknown>): void {
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  function readMeta(dir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
  }

  test("seeds counters into a fresh meta.json", () => {
    const dir = tempRepo();
    writeMeta(dir, { workspace: "broomva", schemaVersion: 1, displayCounters: {} });
    const merged = seedDisplayCounters(dir, { BRO: 1646 });
    expect(merged).toEqual({ BRO: 1646 });
    expect(readMeta(dir).displayCounters).toEqual({ BRO: 1646 });
  });

  test("is monotonic: never lowers an existing counter, merges new keys", () => {
    const dir = tempRepo();
    writeMeta(dir, {
      workspace: "broomva",
      schemaVersion: 1,
      displayCounters: { BRO: 1700, OPS: 12 },
    });
    const merged = seedDisplayCounters(dir, { BRO: 1646, MIN: 2 });
    expect(merged).toEqual({ BRO: 1700, OPS: 12, MIN: 2 });
    expect(readMeta(dir).displayCounters).toEqual({ BRO: 1700, OPS: 12, MIN: 2 });
  });

  test("tolerates meta.json without a displayCounters field", () => {
    const dir = tempRepo();
    writeMeta(dir, { workspace: "broomva", schemaVersion: 1 });
    expect(seedDisplayCounters(dir, { BRO: 1646 })).toEqual({ BRO: 1646 });
  });
});
