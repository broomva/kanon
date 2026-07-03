/**
 * Unit tests for the service core — KanonService driven directly (no HTTP,
 * no MCP), against a temp git data repo. The REST and MCP adapters are thin
 * shells over exactly these methods, so this is where the domain behavior
 * (allocation, LWW updates, blocking, minting) is pinned.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventActor } from "@kanon/core";
import { initDataRepo } from "@kanon/store";
import { KanonService } from "./service";

const ACTOR: EventActor = { type: "agent", id: "svc@example.com", surface: "mcp" };
const dirs: string[] = [];
const services: KanonService[] = [];

afterEach(() => {
  while (services.length > 0) services.pop()?.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function boot(): KanonService {
  const dir = mkdtempSync(join(tmpdir(), "kanon-svc-"));
  dirs.push(dir);
  initDataRepo({ dir, workspace: "test", actor: ACTOR, git: true });
  const service = new KanonService({ dataDir: dir, gitRemoteSync: false, onWarn: () => {} });
  services.push(service);
  return service;
}

describe("KanonService", () => {
  test("createTeam seeds 7 workflow states", () => {
    const service = boot();
    const { team, states } = service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    expect(team?.key).toBe("BRO");
    expect(states.map((s) => s.name)).toEqual([
      "Triage",
      "Backlog",
      "Todo",
      "In Progress",
      "Done",
      "Canceled",
      "Duplicate",
    ]);
    expect(service.listTeams()).toHaveLength(1);
  });

  test("createIssue allocates sequential display numbers", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    expect(service.createIssue(ACTOR, { team: "BRO", title: "One" }).identifier).toBe("BRO-1");
    expect(service.createIssue(ACTOR, { team: "BRO", title: "Two" }).identifier).toBe("BRO-2");
    expect(service.issues({ team: "BRO" })).toHaveLength(2);
  });

  test("updateIssue moves state (per-field LWW)", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const { id } = service.createIssue(ACTOR, { team: "BRO", title: "Ship" });
    service.updateIssue(ACTOR, id, { state: "started", priority: 1 });
    const detail = service.issueDetail(id);
    expect(detail.state?.stateType).toBe("started");
    expect(detail.issue.priority).toBe(1);
  });

  test("ready excludes an issue blocked by an open issue, includes it once unblocked", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const blocker = service.createIssue(ACTOR, { team: "BRO", title: "Blocker" });
    service.createIssue(ACTOR, { team: "BRO", title: "Blocked" });
    service.relate(ACTOR, blocker.id, { type: "blocks", target: "BRO-2" });

    const titles1 = service.ready("BRO").map((issue) => issue.title);
    expect(titles1).toContain("Blocker");
    expect(titles1).not.toContain("Blocked");

    service.updateIssue(ACTOR, blocker.id, { state: "completed" });
    expect(service.ready("BRO").map((issue) => issue.title)).toEqual(["Blocked"]);
  });

  test("comment mints the author actor entity on first use", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const { id } = service.createIssue(ACTOR, { team: "BRO", title: "Discuss" });
    const comment = service.comment(ACTOR, id, { body: "on it" });
    expect(comment.body).toBe("on it");
    expect(service.issueDetail(id).comments).toHaveLength(1);
  });

  test("createIssue rejects an unknown team", () => {
    const service = boot();
    expect(() => service.createIssue(ACTOR, { team: "NOPE", title: "x" })).toThrow();
  });
});
