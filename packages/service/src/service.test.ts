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
import { createEvent, type EventActor } from "@kanon/core";
import { appendEvents, initDataRepo } from "@kanon/store";
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

  test("reloadFromDisk picks up out-of-band appended events and broadcasts them", () => {
    const service = boot();
    const before = service.eventCount();

    // Simulate an out-of-band importer appending straight to the log segments
    // — exactly what tools/linear-import does (no server API, no git). This is
    // the shadow-mirror refresh path: the running server must observe these.
    const event = createEvent({
      workspace: service.workspace,
      actor: { type: "app", id: "linear-import", surface: "import" },
      op: "create",
      model: "team",
      data: { key: "BRO", name: "Broomva" },
    });
    appendEvents(service.dataDir, [event]);

    // Until a reload, the in-memory stream has not moved.
    expect(service.eventCount()).toBe(before);

    const broadcast: string[] = [];
    const unsubscribe = service.bus.subscribe((e) => broadcast.push(e.id));

    const fresh = service.reloadFromDisk();
    expect(fresh.map((e) => e.id)).toEqual([event.id]);
    expect(service.eventCount()).toBe(before + 1);
    expect(broadcast).toEqual([event.id]);
    expect(service.listTeams().map((t) => t.key)).toContain("BRO");

    // Idempotent: a second reload with nothing new returns + broadcasts nothing.
    expect(service.reloadFromDisk()).toEqual([]);
    expect(broadcast).toEqual([event.id]);

    unsubscribe();
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

  test("updateIssue explicit null clears assignee/project/parent (null-to-remove)", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const project = service.createProject(ACTOR, { name: "Alpha" });
    const parent = service.createIssue(ACTOR, { team: "BRO", title: "Parent" });
    const { id } = service.createIssue(ACTOR, {
      team: "BRO",
      title: "Child",
      assignee: "bob@example.com",
      project: "Alpha",
      parent: parent.id,
    });
    const before = service.issueDetail(id).issue;
    expect(before.assigneeId).not.toBeNull();
    expect(before.projectId).toBe(project?.id ?? "");
    expect(before.parentId).toBe(parent.id);

    service.updateIssue(ACTOR, id, { assignee: null, project: null, parent: null });
    const after = service.issueDetail(id).issue;
    expect(after.assigneeId).toBeNull();
    expect(after.projectId).toBeNull();
    expect(after.parentId).toBeNull();
  });

  test("unrelate tombstones the edge; ready unblocks; re-relate mints a fresh edge", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const blocker = service.createIssue(ACTOR, { team: "BRO", title: "Blocker" });
    const blocked = service.createIssue(ACTOR, { team: "BRO", title: "Blocked" });
    service.relate(ACTOR, blocker.id, { type: "blocks", target: blocked.id });
    expect(service.ready("BRO").map((issue) => issue.title)).toEqual(["Blocker"]);

    const removed = service.unrelate(ACTOR, blocker.id, { type: "blocks", target: blocked.id });
    expect(removed.removed).toBe(true);
    expect(
      service
        .ready("BRO")
        .map((issue) => issue.title)
        .sort(),
    ).toEqual(["Blocked", "Blocker"]);
    // Idempotent: the edge is already gone.
    expect(
      service.unrelate(ACTOR, blocker.id, { type: "blocks", target: blocked.id }).removed,
    ).toBe(false);
    // Re-relating creates a NEW edge (the old one stays tombstoned).
    const again = service.relate(ACTOR, blocker.id, { type: "blocks", target: blocked.id });
    expect(again.created).toBe(true);
    expect(again.relation.id).not.toBe(removed.relation?.id);
  });

  test("unrelate related works from either direction (symmetric edge)", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const a = service.createIssue(ACTOR, { team: "BRO", title: "A" });
    const b = service.createIssue(ACTOR, { team: "BRO", title: "B" });
    service.relate(ACTOR, a.id, { type: "related", target: b.id });
    // Remove from the OTHER side — still finds the same edge.
    expect(service.unrelate(ACTOR, b.id, { type: "related", target: a.id }).removed).toBe(true);
    expect(service.issueDetail(a.id).relations).toHaveLength(0);
  });

  test("updateProject renames with uniqueness; comment replies nest one level", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    service.createProject(ACTOR, { name: "Alpha" });
    service.createProject(ACTOR, { name: "Beta" });
    expect(() => service.updateProject(ACTOR, "Beta", { name: "Alpha" })).toThrow(/already exists/);
    const renamed = service.updateProject(ACTOR, "Beta", { name: "Gamma", state: "started" });
    expect(renamed?.name).toBe("Gamma");
    expect(renamed?.state).toBe("started");

    const { id } = service.createIssue(ACTOR, { team: "BRO", title: "Talk" });
    const top = service.comment(ACTOR, id, { body: "top" });
    const reply = service.comment(ACTOR, id, { body: "reply", parentId: top.id });
    expect(reply.parentId).toBe(top.id);
    expect(() => service.comment(ACTOR, id, { body: "nested", parentId: reply.id })).toThrow(
      /one level/,
    );
    const edited = service.updateComment(ACTOR, top.id, { body: "top (edited)" });
    expect(edited.body).toBe("top (edited)");
  });
});

describe("agent sessions", () => {
  test("createAgentSession: pending, delegate seat re-pointed, prompt recorded", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const issue = service.createIssue(ACTOR, { team: "BRO", title: "Delegate me" });
    const { session, activity } = service.createAgentSession(ACTOR, {
      issue: issue.id,
      agent: "worker@agents.local",
      prompt: "Go do it.",
    });
    expect(session?.state).toBe("pending");
    expect(activity?.type).toBe("prompt");
    expect(activity?.body).toBe("Go do it.");
    const delegated = service.issueDetail(issue.id).issue;
    expect(delegated.delegateId).toBe(session?.actorId ?? "");
    // The minted delegate is an agent-type actor.
    const detail = service.agentSessionDetail(session?.id ?? "");
    expect(detail.issue?.id).toBe(issue.id);
    expect(detail.activities).toHaveLength(1);
  });

  test("state machine: thought→active, elicitation→awaitingInput, prompt→active, response→complete, error→error", () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const issue = service.createIssue(ACTOR, { team: "BRO", title: "Work" });
    const { session } = service.createAgentSession(ACTOR, { issue: issue.id });
    const id = session?.id ?? "";
    const step = (type: string) =>
      service.appendAgentActivity(ACTOR, id, { type, body: "x" }).session?.state;
    expect(step("thought")).toBe("active");
    expect(step("elicitation")).toBe("awaitingInput");
    expect(step("prompt")).toBe("active");
    expect(step("response")).toBe("complete");
    // A follow-up prompt reopens a complete session.
    expect(step("prompt")).toBe("active");
    expect(step("error")).toBe("error");
  });

  test("janitor: stales live sessions past the threshold, leaves terminal + fresh ones", async () => {
    const service = boot();
    service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
    const issue = service.createIssue(ACTOR, { team: "BRO", title: "Slow" });
    const stale = service.createAgentSession(ACTOR, { issue: issue.id, agent: "slow@a" });
    const done = service.createAgentSession(ACTOR, { issue: issue.id, agent: "done@a" });
    service.appendAgentActivity(ACTOR, done.session?.id ?? "", {
      type: "response",
      body: "done",
    });
    // Every write includes a git commit (hundreds of ms), so the margins
    // must dwarf commit time: stale/done age ≥ sleep, fresh age ≈ one create.
    await Bun.sleep(1500);
    const fresh = service.createAgentSession(ACTOR, { issue: issue.id, agent: "fresh@a" });

    const { staled } = service.markStaleSessions(ACTOR, 1200);
    const staledIds = staled.map((session) => session.id);
    expect(staledIds).toContain(stale.session?.id ?? "");
    expect(staledIds).not.toContain(done.session?.id ?? ""); // complete is terminal
    expect(staledIds).not.toContain(fresh.session?.id ?? ""); // fresh, under threshold
    expect(service.agentSessionDetail(stale.session?.id ?? "").session.state).toBe("stale");
    // A prompt reactivates a stale session.
    const revived = service.appendAgentActivity(ACTOR, stale.session?.id ?? "", {
      type: "prompt",
      body: "still there?",
    });
    expect(revived.session?.state).toBe("active");
  });
});
