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
