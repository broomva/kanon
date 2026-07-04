/**
 * End-to-end server tests — every scenario drives a real Bun.serve instance
 * on an ephemeral port against a temp data repo (git: true, remote-less).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createEvent, type KanonEvent } from "@kanon/core";
import { api, boot, cleanup, ok, TEST_ACTOR } from "./test-helpers";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// auth + health
// ---------------------------------------------------------------------------

describe("auth", () => {
  test("healthz needs no auth and reports workspace + head", async () => {
    const { url } = boot();
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.workspace).toBe("test");
    expect(body.eventCount).toBe(1); // genesis
    expect(typeof body.head).toBe("string");
  });

  test("missing key → 404 (resource-not-found shape)", async () => {
    const { url } = boot();
    const response = await fetch(`${url}/v1/issues`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("not found");
  });

  test("wrong key → 404, indistinguishable from a nonexistent route", async () => {
    const { url } = boot();
    const denied = await fetch(`${url}/v1/issues`, {
      headers: { authorization: "Bearer some-other-workspaces-key" },
    });
    expect(denied.status).toBe(404);
    const text = await denied.text();
    // No workspace disclosure — a key valid elsewhere learns nothing.
    expect(text).not.toContain("test");
    expect(JSON.parse(text)).toEqual({ error: "not found" });

    // Byte-identical to a genuinely nonexistent /v1 route: the denial reveals
    // nothing about whether the resource — or the workspace — exists here.
    const missing = await fetch(`${url}/v1/does-not-exist`, {
      headers: { authorization: "Bearer some-other-workspaces-key" },
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// ingest + feed
// ---------------------------------------------------------------------------

function clientEvent(data: Record<string, unknown>, workspace = "test"): KanonEvent {
  return createEvent({
    workspace,
    actor: { type: "agent", id: "replica-1", surface: "http" },
    op: "create",
    model: "document",
    data,
  });
}

describe("ingest → feed", () => {
  test("append 3, read after cursor, hasMore paging", async () => {
    const { url } = boot();
    const genesis = (await ok(url, "GET", "/v1/sync/events")).events as KanonEvent[];
    expect(genesis).toHaveLength(1);
    const genesisId = genesis[0]?.id as string;

    const events = [clientEvent({ n: 1 }), clientEvent({ n: 2 }), clientEvent({ n: 3 })];
    const ingest = await api(url, "POST", "/v1/events", { events });
    expect(ingest.status).toBe(201);
    expect(ingest.body.appended).toBe(3);
    expect(ingest.body.head).toBe(events[2]?.id as string);

    // Strictly after the cursor, limited, with hasMore.
    const page1 = await ok(url, "GET", `/v1/sync/events?after=${genesisId}&limit=2`);
    const page1Events = page1.events as KanonEvent[];
    expect(page1Events.map((event) => event.id)).toEqual([
      events[0]?.id as string,
      events[1]?.id as string,
    ]);
    expect(page1.hasMore).toBe(true);

    const page2 = await ok(
      url,
      "GET",
      `/v1/sync/events?after=${page1Events[1]?.id as string}&limit=2`,
    );
    expect((page2.events as KanonEvent[]).map((event) => event.id)).toEqual([
      events[2]?.id as string,
    ]);
    expect(page2.hasMore).toBe(false);
    expect(page2.head).toBe(events[2]?.id as string);
  });

  test("duplicate ids are rejected (already in log, and within a batch)", async () => {
    const { url } = boot();
    const event = clientEvent({ n: 1 });
    expect((await api(url, "POST", "/v1/events", { events: [event] })).status).toBe(201);

    const again = await api(url, "POST", "/v1/events", { events: [event] });
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toContain(event.id);

    const fresh = clientEvent({ n: 2 });
    const doubled = await api(url, "POST", "/v1/events", { events: [fresh, fresh] });
    expect(doubled.status).toBe(409);

    // The rejected batches never landed.
    const feed = await ok(url, "GET", "/v1/sync/events");
    expect((feed.events as KanonEvent[]).filter((entry) => entry.id === fresh.id)).toHaveLength(0);
  });

  test("wrong-workspace events are rejected", async () => {
    const { url } = boot();
    const foreign = clientEvent({ n: 1 }, "other-workspace");
    const result = await api(url, "POST", "/v1/events", { events: [foreign] });
    expect(result.status).toBe(422);
    expect(String(result.body.error)).toContain("workspace");
  });

  test("malformed events and bodies → 400", async () => {
    const { url } = boot();
    expect((await api(url, "POST", "/v1/events", { events: [{ nope: true }] })).status).toBe(400);
    expect((await api(url, "POST", "/v1/events", { events: [] })).status).toBe(400);
    expect((await api(url, "POST", "/v1/events", "not an object")).status).toBe(400);
    expect((await api(url, "GET", "/v1/sync/events?after=not-a-ulid")).status).toBe(400);
    expect((await api(url, "GET", "/v1/sync/events?limit=5000")).status).toBe(400);
  });

  test("server-written events carry the key's actor + session prefix", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/projects", { name: "Attributed" });
    const feed = await ok(url, "GET", "/v1/sync/events");
    const projectEvent = (feed.events as KanonEvent[]).find((event) => event.model === "project");
    expect(projectEvent).toBeDefined();
    expect(projectEvent?.actor.id).toBe("carlos@example.com");
    expect(projectEvent?.actor.type).toBe("human");
    expect(projectEvent?.actor.surface).toBe("http");
    expect(projectEvent?.actor.sessionId).toStartWith("sess-");
  });
});

// ---------------------------------------------------------------------------
// teams, issues, allocation
// ---------------------------------------------------------------------------

describe("issues", () => {
  test("team create seeds 7 states; issue create allocates BRO-1", async () => {
    const { url } = boot();
    const team = await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    expect((team.states as unknown[]).length).toBe(7);
    expect((team.team as { key: string }).key).toBe("BRO");

    const dup = await api(url, "POST", "/v1/teams", { key: "bro", name: "Again" });
    expect(dup.status).toBe(409);

    const issue = await ok(url, "POST", "/v1/issues", { team: "BRO", title: "First" });
    expect(issue.identifier).toBe("BRO-1");
    expect(issue.number).toBe(1);
    expect((issue.issue as { title: string }).title).toBe("First");
  });

  test("8 PARALLEL creates allocate unique sequential numbers", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        api(url, "POST", "/v1/issues", { team: "BRO", title: `Parallel ${index}` }),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe(201);
    }
    const numbers = results.map((result) => result.body.number as number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const list = await ok(url, "GET", "/v1/issues?team=BRO");
    expect((list.issues as unknown[]).length).toBe(8);
  });

  test("PATCH state by type name; detail resolves the state", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Ship it" });

    const patched = await ok(url, "PATCH", "/v1/issues/BRO-1", { state: "started", priority: 2 });
    const issue = patched.issue as { stateId: string; priority: number };
    expect(issue.priority).toBe(2);

    const detail = await ok(url, "GET", "/v1/issues/BRO-1");
    const state = detail.state as { name: string; stateType: string };
    expect(state.stateType).toBe("started");
    expect(state.name).toBe("In Progress");

    expect((await api(url, "PATCH", "/v1/issues/BRO-1", {})).status).toBe(400);
    expect((await api(url, "PATCH", "/v1/issues/BRO-999", { state: "started" })).status).toBe(404);
  });

  test("delegate by name mints an actor entity; comments mint the author", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", {
      team: "BRO",
      title: "Delegated",
      delegate: "runner-bot",
    });

    const detail = await ok(url, "GET", "/v1/issues/BRO-1");
    const issue = detail.issue as { delegateId: string | null };
    expect(issue.delegateId).not.toBeNull();

    const comment = await ok(
      url,
      "POST",
      "/v1/issues/BRO-1/comments",
      { body: "on it" },
      "agent-key",
    );
    const written = comment.comment as { body: string; actorId: string };
    expect(written.body).toBe("on it");

    const after = await ok(url, "GET", "/v1/issues/BRO-1");
    expect((after.comments as unknown[]).length).toBe(1);

    // The minted delegate is attributed as an agent actor entity in the log.
    const feed = await ok(url, "GET", "/v1/sync/events");
    const mint = (feed.events as KanonEvent[]).find(
      (event) => event.model === "actor" && event.data.name === "runner-bot",
    );
    expect(mint?.data.actorType).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// catalog (web-UI bootstrap)
// ---------------------------------------------------------------------------

describe("initiatives", () => {
  test("POST creates an initiative; GET lists it (fields ride the data overflow)", async () => {
    const { url } = boot();
    const created = await ok(url, "POST", "/v1/initiatives", {
      name: "Agent OS",
      description: "umbrella",
      targetDate: "2027-09-30",
    });
    const initiative = created.initiative as { id: string };
    expect(initiative.id).toHaveLength(26);

    const list = await ok(url, "GET", "/v1/initiatives");
    const initiatives = list.initiatives as { id: string; data: Record<string, unknown> }[];
    expect(
      initiatives.some((i) => i.data.name === "Agent OS" && i.data.targetDate === "2027-09-30"),
    ).toBe(true);
  });
});

describe("status updates", () => {
  test("POST creates a status update on a project; GET lists it (health rides the overflow)", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/projects", { name: "Kanon", description: "tracker" });

    const created = await ok(url, "POST", "/v1/status-updates", {
      type: "project",
      project: "Kanon",
      health: "onTrack",
      body: "shipping M5b",
    });
    const statusUpdate = created.statusUpdate as { id: string; data: Record<string, unknown> };
    expect(statusUpdate.id).toHaveLength(26);
    expect(statusUpdate.data.health).toBe("onTrack");

    const list = await ok(url, "GET", "/v1/status-updates");
    const updates = list.statusUpdates as { id: string; data: Record<string, unknown> }[];
    expect(updates.some((u) => u.data.type === "project" && u.data.body === "shipping M5b")).toBe(
      true,
    );

    // unknown parent → 404
    const missing = await api(url, "POST", "/v1/status-updates", {
      type: "project",
      project: "Nope",
    });
    expect(missing.status).toBe(404);
  });
});

describe("documents", () => {
  test("POST creates a doc on a project; GET lists it; exactly-one-parent enforced", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/projects", { name: "Kanon", description: "tracker" });

    const created = await ok(url, "POST", "/v1/documents", {
      title: "Design doc",
      content: "the plan",
      project: "Kanon",
    });
    const doc = created.document as { id: string; data: Record<string, unknown> };
    expect(doc.id).toHaveLength(26);
    expect(doc.data.parentType).toBe("project");

    const list = await ok(url, "GET", "/v1/documents");
    const documents = list.documents as { data: Record<string, unknown> }[];
    expect(
      documents.some((d) => d.data.title === "Design doc" && d.data.content === "the plan"),
    ).toBe(true);

    // no parent → 400; two parents → 400; unknown parent → 404
    expect((await api(url, "POST", "/v1/documents", { title: "Orphan" })).status).toBe(400);
    const team = await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    expect((team.team as { key: string }).key).toBe("BRO");
    expect(
      (await api(url, "POST", "/v1/documents", { title: "Two", project: "Kanon", team: "BRO" }))
        .status,
    ).toBe(400);
    expect((await api(url, "POST", "/v1/documents", { title: "X", project: "Nope" })).status).toBe(
      404,
    );
  });
});

describe("cycles", () => {
  test("POST creates a cycle on a team; GET lists it; team required / resolved", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });

    const created = await ok(url, "POST", "/v1/cycles", {
      team: "BRO",
      name: "Sprint 1",
      number: 1,
      startsAt: "2026-07-01",
      endsAt: "2026-07-14",
    });
    const cycle = created.cycle as { id: string; data: Record<string, unknown> };
    expect(cycle.id).toHaveLength(26);
    expect(cycle.data.name).toBe("Sprint 1");
    expect(cycle.data.number).toBe(1);

    const list = await ok(url, "GET", "/v1/cycles");
    const cycles = list.cycles as { data: Record<string, unknown> }[];
    expect(cycles.some((c) => c.data.name === "Sprint 1")).toBe(true);

    // no team → 400; unknown team → 404
    expect((await api(url, "POST", "/v1/cycles", { name: "Orphan" })).status).toBe(400);
    expect((await api(url, "POST", "/v1/cycles", { team: "NOPE", name: "X" })).status).toBe(404);
  });
});

describe("catalog", () => {
  test("returns the workspace + resolvable teams/states/projects/labels/actors", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/projects", { name: "Kanon" });
    await ok(url, "POST", "/v1/issues", {
      team: "BRO",
      title: "Ship the UI",
      delegate: "claude",
      labels: ["infra"],
    });

    const catalog = await ok(url, "GET", "/v1/catalog");
    expect(catalog.workspace).toBe("test");

    const teams = catalog.teams as { key: string }[];
    expect(teams.some((t) => t.key === "BRO")).toBe(true);

    // Team create seeds the 7 default workflow states — the board columns.
    const states = catalog.states as { stateType: string }[];
    expect(states.length).toBeGreaterThanOrEqual(7);
    expect(states.some((s) => s.stateType === "started")).toBe(true);

    const projects = catalog.projects as { name: string }[];
    expect(projects.some((p) => p.name === "Kanon")).toBe(true);

    // The delegate + label minted entities the UI resolves by id.
    const actors = catalog.actors as { name: string | null }[];
    expect(actors.some((a) => a.name === "claude")).toBe(true);
    const labels = catalog.labels as { name: string | null }[];
    expect(labels.some((l) => l.name === "infra")).toBe(true);
  });

  test("needs auth — a foreign key learns nothing", async () => {
    const { url } = boot();
    const denied = await fetch(`${url}/v1/catalog`, {
      headers: { authorization: "Bearer some-other-workspaces-key" },
    });
    expect(denied.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// ready + blocking
// ---------------------------------------------------------------------------

describe("ready", () => {
  test("reflects blocking through relations", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Blocker" }); // BRO-1
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Blocked" }); // BRO-2

    const relation = await api(url, "POST", "/v1/issues/BRO-1/relations", {
      type: "blocks",
      target: "BRO-2",
    });
    expect(relation.status).toBe(201);

    const ready1 = await ok(url, "GET", "/v1/ready?team=BRO");
    const titles1 = (ready1.issues as { title: string }[]).map((issue) => issue.title);
    expect(titles1).toContain("Blocker");
    expect(titles1).not.toContain("Blocked");

    // Completing the blocker unblocks the dependent.
    await ok(url, "PATCH", "/v1/issues/BRO-1", { state: "completed" });
    const ready2 = await ok(url, "GET", "/v1/ready?team=BRO");
    const titles2 = (ready2.issues as { title: string }[]).map((issue) => issue.title);
    expect(titles2).toEqual(["Blocked"]);

    // Idempotent relate: 200, not a duplicate edge.
    const again = await api(url, "POST", "/v1/issues/BRO-1/relations", {
      type: "blocks",
      target: "BRO-2",
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// relation removal + null-to-remove (M3 Phase 2)
// ---------------------------------------------------------------------------

describe("relation removal + null-to-remove", () => {
  test("DELETE relations tombstones the edge; unblocks; idempotent", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Blocker" }); // BRO-1
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Blocked" }); // BRO-2
    await ok(url, "POST", "/v1/issues/BRO-1/relations", { type: "blocks", target: "BRO-2" });

    const removed = await api(url, "DELETE", "/v1/issues/BRO-1/relations", {
      type: "blocks",
      target: "BRO-2",
    });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);

    const ready = await ok(url, "GET", "/v1/ready?team=BRO");
    expect((ready.issues as { title: string }[]).map((issue) => issue.title).sort()).toEqual([
      "Blocked",
      "Blocker",
    ]);
    // Removing again: honest false, no phantom write.
    const again = await api(url, "DELETE", "/v1/issues/BRO-1/relations", {
      type: "blocks",
      target: "BRO-2",
    });
    expect(again.body.removed).toBe(false);
  });

  test("PATCH assignee:null clears the seat", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "X", assignee: "bob@x.io" });
    expect((await ok(url, "GET", "/v1/issues/BRO-1")).issue).toHaveProperty("assigneeId");
    const before = (await ok(url, "GET", "/v1/issues/BRO-1")).issue as {
      assigneeId: string | null;
    };
    expect(before.assigneeId).not.toBeNull();

    await ok(url, "PATCH", "/v1/issues/BRO-1", { assignee: null });
    const after = (await ok(url, "GET", "/v1/issues/BRO-1")).issue as { assigneeId: string | null };
    expect(after.assigneeId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// agent sessions + activities (M3 Phase 2)
// ---------------------------------------------------------------------------

describe("agent sessions", () => {
  test("delegate → activity timeline → complete; delegate seat re-pointed", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Ship" });

    const created = await ok(url, "POST", "/v1/agent-sessions", {
      issue: "BRO-1",
      agent: "worker-bot",
      prompt: "Ship it end to end.",
    });
    const session = created.session as { id: string; state: string };
    expect(session.state).toBe("pending");
    expect((created.activity as { type: string }).type).toBe("prompt");

    // The issue's delegate seat now points at the session's agent.
    const issue = (await ok(url, "GET", "/v1/issues/BRO-1")).issue as { delegateId: string | null };
    expect(issue.delegateId).not.toBeNull();

    const step = async (type: string, body: string) => {
      const result = await ok(url, "POST", `/v1/agent-sessions/${session.id}/activities`, {
        type,
        body,
      });
      return (result.session as { state: string }).state;
    };
    expect(await step("thought", "reading")).toBe("active");
    expect(await step("elicitation", "prod too?")).toBe("awaitingInput");
    expect(await step("prompt", "yes")).toBe("active");
    expect(await step("response", "done")).toBe("complete");

    const detail = await ok(url, "GET", `/v1/agent-sessions/${session.id}`);
    expect((detail.session as { state: string }).state).toBe("complete");
    expect((detail.activities as unknown[]).length).toBe(5);
    expect((detail.issue as { identifier: string }).identifier).toBe("BRO-1");

    // Filter by state.
    const complete = await ok(url, "GET", "/v1/agent-sessions?state=complete");
    expect((complete.sessions as unknown[]).length).toBe(1);
    expect((await ok(url, "GET", "/v1/agent-sessions?state=pending")).sessions).toEqual([]);
  });

  test("unknown session → 404; bad activity type → 400", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "X" });
    const created = await ok(url, "POST", "/v1/agent-sessions", { issue: "BRO-1" });
    const id = (created.session as { id: string }).id;
    expect((await api(url, "GET", "/v1/agent-sessions/01AAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(
      404,
    );
    expect(
      (await api(url, "POST", `/v1/agent-sessions/${id}/activities`, { type: "nope", body: "x" }))
        .status,
    ).toBe(400);
  });

  test("janitor stales an idle live session", async () => {
    // 40ms threshold, 20ms tick.
    const { url } = boot({ sessionStaleMs: "40", sessionJanitorIntervalMs: "20" });
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Idle" });
    const created = await ok(url, "POST", "/v1/agent-sessions", { issue: "BRO-1" });
    const id = (created.session as { id: string }).id;

    // Wait past threshold + a couple of ticks; the server janitor marks it stale.
    await Bun.sleep(400);
    const detail = await ok(url, "GET", `/v1/agent-sessions/${id}`);
    expect((detail.session as { state: string }).state).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// MCP over streamable HTTP (same surface as the stdio MCP, 404-shaped auth)
// ---------------------------------------------------------------------------

describe("MCP HTTP transport", () => {
  const RPC = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  async function rpc(url: string, key: string | undefined, body: unknown) {
    return fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        ...RPC,
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify(body),
    });
  }

  test("unauthorized /mcp → 404, indistinguishable from a missing route", async () => {
    const { url } = boot();
    const denied = await rpc(url, "some-other-workspaces-key", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("test");
  });

  test("tools/list advertises the linear-server surface + kanon extensions", async () => {
    const { url } = boot();
    const response = await rpc(url, "agent-key", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { tools: { name: string }[] };
    };
    const names = payload.result.tools.map((tool) => tool.name);
    expect(names).toContain("save_issue");
    expect(names).toContain("create_agent_session");
    expect(names).toContain("append_agent_activity");
  });

  test("tools/call save_issue writes through the same log the REST API reads", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    const response = await rpc(url, "agent-key", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "save_issue", arguments: { team: "BRO", title: "Via MCP" } },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { content: { text: string }[] };
    };
    expect(payload.result.content[0]?.text).toContain("BRO-1");

    // The issue is visible over REST — one log, two adapters.
    const list = await ok(url, "GET", "/v1/issues?team=BRO");
    expect((list.issues as { title: string }[])[0]?.title).toBe("Via MCP");
  });
});

// ---------------------------------------------------------------------------
// projection rebuild-from-scratch
// ---------------------------------------------------------------------------

describe("rebuild", () => {
  test("delete state.db + restart → identical /v1/issues", async () => {
    const first = boot();
    await ok(first.url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(first.url, "POST", "/v1/issues", {
      team: "BRO",
      title: "Alpha",
      labels: ["infra"],
      priority: 1,
    });
    await ok(first.url, "POST", "/v1/issues", { team: "BRO", title: "Beta", delegate: "bot" });
    await ok(first.url, "PATCH", "/v1/issues/BRO-2", { state: "started" });
    await ok(first.url, "POST", "/v1/issues/BRO-1/comments", { body: "note" });

    const before = await ok(first.url, "GET", "/v1/issues?team=BRO");
    const healthBefore = await (await fetch(`${first.url}/healthz`)).json();
    first.server.stop();

    // The projection is a DISPOSABLE cache: nuke it, restart, replay rebuilds.
    rmSync(join(first.dataDir, "state.db"), { force: true });
    const second = boot({ dataDir: first.dataDir });
    const after = await ok(second.url, "GET", "/v1/issues?team=BRO");
    const healthAfter = await (await fetch(`${second.url}/healthz`)).json();

    expect(after).toEqual(before);
    expect((healthAfter as { eventCount: number }).eventCount).toBe(
      (healthBefore as { eventCount: number }).eventCount,
    );
    expect((healthAfter as { head: string }).head).toBe((healthBefore as { head: string }).head);
  });
});

// ---------------------------------------------------------------------------
// data repo stays valid under server writes
// ---------------------------------------------------------------------------

describe("log integrity", () => {
  test("server writes keep the data repo schema-valid and committed", async () => {
    const { url, dataDir } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Committed" });

    const { validateDataRepo } = await import("@kanon/store");
    const validation = validateDataRepo(dataDir);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);

    // One commit per write request, authored by the server identity.
    const log = Bun.spawnSync(["git", "log", "--format=%an %s"], { cwd: dataDir });
    const lines = log.stdout.toString().trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain("kanon-server");

    // Genesis event from initDataRepo is attributed to the test actor.
    expect(TEST_ACTOR.id).toBe("carlos@example.com");
  });
});

describe("labels — team scoping", () => {
  test("same label name in two teams mints two distinct team-scoped labels", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/teams", { key: "OPS", name: "Platform" });

    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "A", labels: ["infra"] });
    await ok(url, "POST", "/v1/issues", { team: "OPS", title: "B", labels: ["infra"] });

    const catalog = await ok(url, "GET", "/v1/catalog");
    const teams = catalog.teams as { id: string; key: string }[];
    const bro = teams.find((t) => t.key === "BRO");
    const ops = teams.find((t) => t.key === "OPS");
    const infra = (catalog.labels as { name: string | null; teamId: string | null }[]).filter(
      (label) => label.name === "infra",
    );
    // Two labels named "infra", one scoped to each team — not silently shared.
    expect(infra.length).toBe(2);
    expect(new Set(infra.map((l) => l.teamId))).toEqual(
      new Set([bro?.id ?? null, ops?.id ?? null]),
    );
  });

  test("attaching another team's label by ULID is refused", async () => {
    const { url } = boot();
    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await ok(url, "POST", "/v1/teams", { key: "OPS", name: "Platform" });
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "A", labels: ["infra"] });

    const catalog = await ok(url, "GET", "/v1/catalog");
    const infraId = (catalog.labels as { id: string; name: string | null }[]).find(
      (label) => label.name === "infra",
    )?.id as string;

    // BRO's label, referenced by id from an OPS issue → 400 (not in scope).
    const res = await api(url, "POST", "/v1/issues", {
      team: "OPS",
      title: "B",
      labels: [infraId],
    });
    expect(res.status).toBe(400);
  });
});
