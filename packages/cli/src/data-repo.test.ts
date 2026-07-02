import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent } from "@kanon/core";
import { appendEvents, initDataRepo, validateDataRepo } from "./data-repo";

const actor = { type: "agent", id: "test-agent", surface: "cli" } as const;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanon-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("initDataRepo", () => {
  test("creates the canonical layout with a schema-valid genesis event", () => {
    const dir = tempDir();
    const result = initDataRepo({ dir, workspace: "broomva", actor, git: false });

    expect(result.meta.workspace).toBe("broomva");
    expect(result.genesis.model).toBe("workspace");
    expect(readFileSync(join(dir, "meta.json"), "utf8")).toContain('"workspace": "broomva"');

    const validation = validateDataRepo(dir);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.eventCount).toBe(1);
  });

  test("rejects invalid workspace slugs", () => {
    expect(() =>
      initDataRepo({ dir: tempDir(), workspace: "Not A Slug", actor, git: false }),
    ).toThrow();
  });

  test("git: true initializes a repository", () => {
    const dir = tempDir();
    const result = initDataRepo({ dir, workspace: "broomva", actor, git: true });
    expect(result.gitInitialized).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("state.db");
  });
});

describe("appendEvents + validateDataRepo", () => {
  test("events route to monthly segments and stay valid", () => {
    const dir = tempDir();
    initDataRepo({ dir, workspace: "broomva", actor, git: false });

    const issueEvent = createEvent({
      workspace: "broomva",
      actor,
      op: "create",
      model: "issue",
      data: { title: "Ship M0" },
      ts: "2026-08-15T10:00:00.000Z",
    });
    appendEvents(dir, [issueEvent]);

    const validation = validateDataRepo(dir);
    expect(validation.ok).toBe(true);
    expect(validation.eventCount).toBe(2);
    expect(readFileSync(join(dir, "events", "2026-08.jsonl"), "utf8")).toContain("Ship M0");
  });

  test("corruption is caught with segment:line coordinates", () => {
    const dir = tempDir();
    initDataRepo({ dir, workspace: "broomva", actor, git: false });
    const segment = new Date().toISOString().slice(0, 7);
    appendFileSync(join(dir, "events", `${segment}.jsonl`), '{"not":"an event"}\n');

    const validation = validateDataRepo(dir);
    expect(validation.ok).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
    expect(validation.errors[0]).toContain(`${segment}.jsonl:2`);
  });

  test("cross-workspace events are rejected", () => {
    const dir = tempDir();
    initDataRepo({ dir, workspace: "broomva", actor, git: false });
    const foreign = createEvent({
      workspace: "stimulus",
      actor,
      op: "create",
      model: "issue",
      data: {},
    });
    appendEvents(dir, [foreign]);

    const validation = validateDataRepo(dir);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.includes("stimulus"))).toBe(true);
  });
});
