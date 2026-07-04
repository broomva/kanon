/**
 * MCP integration tests — a real MCP Client talks to the Kanon MCP server
 * over an in-memory transport, against a temp git data repo. Exercises the
 * tool surface end-to-end exactly as an agent's MCP client would.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventActor } from "@kanon/core";
import { KanonService } from "@kanon/service";
import { initDataRepo } from "@kanon/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKanonMcpServer } from "./server";

const ACTOR: EventActor = { type: "agent", id: "claude@example.com", surface: "mcp" };
const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  while (closers.length > 0) closers.pop()?.();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  client: Client;
  service: KanonService;
}

async function boot(seedTeam = true): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "kanon-mcp-"));
  dirs.push(dir);
  initDataRepo({ dir, workspace: "test", actor: ACTOR, git: true });
  const service = new KanonService({ dataDir: dir, gitRemoteSync: false, onWarn: () => {} });
  if (seedTeam) service.createTeam(ACTOR, { key: "BRO", name: "Broomva" });
  const server = createKanonMcpServer(service, ACTOR);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  closers.push(() => {
    void client.close();
    void server.close();
    service.close();
  });
  return { client, service };
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("kanon MCP server", () => {
  test("advertises the linear-server identity + tool surface", async () => {
    const { client } = await boot();
    expect(client.getServerVersion()?.name).toBe("linear-server");
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("save_issue");
    expect(names).toContain("list_issues");
    expect(names).toContain("list_issue_statuses");
    expect(tools.length).toBeGreaterThanOrEqual(13);
  });

  test("list_teams reflects the seeded team", async () => {
    const { client } = await boot();
    const result = await call(client, "list_teams", {});
    expect(text(result)).toContain("BRO");
    expect(text(result)).toContain("Broomva");
  });

  test("save_issue create → allocates BRO-1; get_issue reads it back", async () => {
    const { client } = await boot();
    const created = await call(client, "save_issue", { team: "BRO", title: "First issue" });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("BRO-1");
    expect(text(created)).toContain("First issue");

    const listed = await call(client, "list_issues", { team: "BRO" });
    expect(text(listed)).toContain("BRO-1");

    const detail = await call(client, "get_issue", { id: "BRO-1" });
    expect(text(detail)).toContain("First issue");
    expect(text(detail)).toContain("Backlog");
  });

  test("save_issue update by identifier moves state + priority", async () => {
    const { client } = await boot();
    await call(client, "save_issue", { team: "BRO", title: "Ship it" });
    const updated = await call(client, "save_issue", {
      id: "BRO-1",
      state: "started",
      priority: 2,
    });
    expect(updated.isError).toBeFalsy();
    expect(text(updated)).toContain("In Progress");

    const detail = await call(client, "get_issue", { id: "BRO-1" });
    expect(text(detail)).toContain("In Progress");
    expect(text(detail)).toContain("High"); // priority 2
  });

  test("save_issue blocks relation shows on both issues", async () => {
    const { client } = await boot();
    await call(client, "save_issue", { team: "BRO", title: "Blocker" }); // BRO-1
    await call(client, "save_issue", { team: "BRO", title: "Blocked" }); // BRO-2
    const related = await call(client, "save_issue", { id: "BRO-1", blocks: ["BRO-2"] });
    expect(text(related)).toContain("blocks BRO-2");

    const blocked = await call(client, "get_issue", { id: "BRO-2" });
    expect(text(blocked)).toContain("blocked by BRO-1");
  });

  test("comments: save then list", async () => {
    const { client } = await boot();
    await call(client, "save_issue", { team: "BRO", title: "Discuss" });
    const commented = await call(client, "save_comment", { issueId: "BRO-1", body: "on it" });
    expect(commented.isError).toBeFalsy();
    const listed = await call(client, "list_comments", { issueId: "BRO-1" });
    expect(text(listed)).toContain("on it");
  });

  test("list_issue_statuses returns the 7 seeded states", async () => {
    const { client } = await boot();
    const result = await call(client, "list_issue_statuses", { team: "BRO" });
    for (const name of [
      "Triage",
      "Backlog",
      "Todo",
      "In Progress",
      "Done",
      "Canceled",
      "Duplicate",
    ]) {
      expect(text(result)).toContain(name);
    }
  });

  test("save_project create; list + get project", async () => {
    const { client } = await boot();
    const created = await call(client, "save_project", { name: "Kanon", description: "tracker" });
    expect(created.isError).toBeFalsy();
    expect(text(await call(client, "list_projects", {}))).toContain("Kanon");
    expect(text(await call(client, "get_project", { query: "Kanon" }))).toContain("tracker");
  });

  test("save_initiative create + update; list + get; duplicate name rejected", async () => {
    const { client } = await boot();
    const created = await call(client, "save_initiative", {
      name: "Agent OS",
      description: "umbrella",
      status: "Active",
      targetDate: "2027-09-30",
    });
    expect(created.isError).toBeFalsy();
    const id = text(created).match(/\*\*ID\*\*: ([0-9A-HJKMNP-TV-Z]{26})/)?.[1];
    expect(id).toBeDefined();

    expect(text(await call(client, "list_initiatives", {}))).toContain("Agent OS");
    const got = text(await call(client, "get_initiative", { query: "Agent OS" }));
    expect(got).toContain("umbrella");
    expect(got).toContain("Active");

    const updated = await call(client, "save_initiative", { id, status: "Completed" });
    expect(updated.isError).toBeFalsy();
    expect(text(updated)).toContain("Completed");

    const dup = await call(client, "save_initiative", { name: "Agent OS" });
    expect(dup.isError).toBe(true);
  });

  test("save_status_update create + update; get single + list; parent required", async () => {
    const { client } = await boot();
    await call(client, "save_project", { name: "Kanon", description: "tracker" });

    const created = await call(client, "save_status_update", {
      type: "project",
      project: "Kanon",
      health: "onTrack",
      body: "shipping M5b",
    });
    expect(created.isError).toBeFalsy();
    const id = text(created).match(/\*\*ID\*\*: ([0-9A-HJKMNP-TV-Z]{26})/)?.[1];
    expect(id).toBeDefined();

    const list = text(await call(client, "get_status_updates", { type: "project" }));
    expect(list).toContain("onTrack");
    expect(list).toContain("Status updates (1)");

    const got = text(await call(client, "get_status_updates", { type: "project", id }));
    expect(got).toContain("shipping M5b");
    expect(got).toContain("onTrack");

    const updated = await call(client, "save_status_update", {
      type: "project",
      id,
      health: "atRisk",
    });
    expect(updated.isError).toBeFalsy();
    expect(text(updated)).toContain("atRisk");
    // Health-only update is field-level LWW — the untouched body must survive.
    expect(text(updated)).toContain("shipping M5b");

    // filtered by a project with no updates → empty
    const bump = await call(client, "get_status_updates", { type: "project", project: "Nope" });
    expect(text(bump)).toContain("_No status updates._");

    // create without a parent → error; bad health → error
    expect((await call(client, "save_status_update", { type: "project" })).isError).toBe(true);
    expect(
      (
        await call(client, "save_status_update", {
          type: "project",
          project: "Kanon",
          health: "bogus",
        })
      ).isError,
    ).toBe(true);
  });

  test("save_document create + reparent update; get + list + parent filter; exactly-one-parent", async () => {
    const { client } = await boot();
    await call(client, "save_project", { name: "Kanon", description: "tracker" });
    await call(client, "save_project", { name: "Other", description: "second" });

    const created = await call(client, "save_document", {
      title: "Design doc",
      content: "the plan",
      project: "Kanon",
    });
    expect(created.isError).toBeFalsy();
    const id = text(created).match(/\*\*ID\*\*: ([0-9A-HJKMNP-TV-Z]{26})/)?.[1];
    expect(id).toBeDefined();

    expect(text(await call(client, "list_documents", {}))).toContain("Design doc");
    const got = text(await call(client, "get_document", { id }));
    expect(got).toContain("the plan");
    expect(got).toContain("project");

    // reparent to Other + rename; content is untouched → survives (field-level LWW)
    const updated = await call(client, "save_document", { id, title: "Renamed", project: "Other" });
    expect(updated.isError).toBeFalsy();
    expect(text(updated)).toContain("Renamed");
    expect(text(updated)).toContain("the plan");

    // filter follows the reparent: new parent finds it, old parent is empty
    expect(text(await call(client, "list_documents", { projectId: "Other" }))).toContain("Renamed");
    expect(text(await call(client, "list_documents", { projectId: "Kanon" }))).toContain(
      "_No documents._",
    );

    // no parent on create → error; two parents → error
    expect((await call(client, "save_document", { title: "Orphan" })).isError).toBe(true);
    expect(
      (await call(client, "save_document", { title: "Two", project: "Kanon", team: "BRO" }))
        .isError,
    ).toBe(true);
  });

  test("unknown issue → isError, not a protocol crash", async () => {
    const { client } = await boot();
    const result = await call(client, "get_issue", { id: "BRO-999" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("BRO-999");
  });

  // -- P20 fixes: B1 unassigned filter, B2 project/parent update, B3 null-reject

  test('list_issues assignee "null" returns unassigned issues (not an error)', async () => {
    const { client } = await boot();
    await call(client, "save_issue", { team: "BRO", title: "Unassigned" }); // BRO-1, no assignee
    await call(client, "save_issue", {
      team: "BRO",
      title: "Assigned",
      assignee: "someone@example.com",
    }); // BRO-2

    const result = await call(client, "list_issues", { team: "BRO", assignee: "null" });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("BRO-1");
    expect(text(result)).not.toContain("BRO-2");
  });

  test("save_issue update sets project and parent (no silent no-op)", async () => {
    const { client } = await boot();
    await call(client, "save_project", { name: "Alpha" });
    await call(client, "save_issue", { team: "BRO", title: "Parent" }); // BRO-1
    await call(client, "save_issue", { team: "BRO", title: "Child" }); // BRO-2

    const moved = await call(client, "save_issue", {
      id: "BRO-2",
      project: "Alpha",
      parentId: "BRO-1",
    });
    expect(moved.isError).toBeFalsy();
    const detail = text(await call(client, "get_issue", { id: "BRO-2" }));
    expect(detail).toContain("Alpha"); // project
    expect(detail).toContain("BRO-1"); // parent
  });

  test("save_issue null-to-remove clears the seat (Phase 2)", async () => {
    const { client } = await boot();
    await call(client, "save_issue", {
      team: "BRO",
      title: "Assigned",
      assignee: "bob@example.com",
    });
    expect(text(await call(client, "get_issue", { id: "BRO-1" }))).toContain("bob");
    const result = await call(client, "save_issue", { id: "BRO-1", assignee: null });
    expect(result.isError).toBeFalsy();
    expect(text(await call(client, "get_issue", { id: "BRO-1" }))).not.toContain("bob");
  });

  test("save_issue removeBlocks removes the relation, idempotently (Phase 2)", async () => {
    const { client } = await boot();
    await call(client, "save_issue", { team: "BRO", title: "Blocker" }); // BRO-1
    await call(client, "save_issue", { team: "BRO", title: "Blocked", blockedBy: ["BRO-1"] });
    expect(text(await call(client, "get_issue", { id: "BRO-2" }))).toContain("blocked by BRO-1");
    const removed = await call(client, "save_issue", { id: "BRO-2", removeBlockedBy: ["BRO-1"] });
    expect(removed.isError).toBeFalsy();
    expect(text(removed)).toContain("-blocked-by BRO-1");
    expect(text(await call(client, "get_issue", { id: "BRO-2" }))).not.toContain("blocked by");
    // Removing a relation that no longer exists is reported honestly.
    const again = await call(client, "save_issue", { id: "BRO-2", removeBlockedBy: ["BRO-1"] });
    expect(text(again)).toContain("no such relation");
  });

  test("save_project update + save_comment edit/reply (Phase 2)", async () => {
    const { client } = await boot();
    await call(client, "save_project", { name: "Kanon" });
    const updated = await call(client, "save_project", { id: "Kanon", state: "started" });
    expect(updated.isError).toBeFalsy();
    expect(text(updated)).toContain("started");

    await call(client, "save_issue", { team: "BRO", title: "Talk" });
    const first = await call(client, "save_comment", { issueId: "BRO-1", body: "top-level" });
    expect(first.isError).toBeFalsy();
    const commentId = /`([0-9A-HJKMNP-TV-Z]{26})`/.exec(text(first))?.[1];
    expect(commentId).toBeDefined();
    const reply = await call(client, "save_comment", {
      issueId: "BRO-1",
      body: "a reply",
      parentId: commentId,
    });
    expect(reply.isError).toBeFalsy();
    const edit = await call(client, "save_comment", { id: commentId, body: "edited body" });
    expect(edit.isError).toBeFalsy();
    const listed = text(await call(client, "list_comments", { issueId: "BRO-1" }));
    expect(listed).toContain("edited body");
    expect(listed).toContain("↳");
    expect(listed).toContain("a reply");
  });
});

describe("agent-session platform (M3 Phase 2)", () => {
  test("delegation E2E: session lifecycle + live activity timeline", async () => {
    const { client, service } = await boot();
    await call(client, "save_issue", { team: "BRO", title: "Ship the thing" });

    // Delegate: session starts pending; the delegate seat re-points to the agent.
    const created = await call(client, "create_agent_session", {
      issue: "BRO-1",
      agent: "worker@agents.local",
      prompt: "Please ship the thing end to end.",
    });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("**State**: pending");
    expect(text(await call(client, "get_issue", { id: "BRO-1" }))).toContain("worker@agents.local");
    const sessionId = /`([0-9A-HJKMNP-TV-Z]{26})`/.exec(text(created))?.[1];
    expect(sessionId).toBeDefined();

    // The agent works: thought/action → active, elicitation → awaitingInput.
    const act = (type: string, body: string) =>
      call(client, "append_agent_activity", { sessionId, type, body });
    expect(text(await act("thought", "Reading the code."))).toContain("**active**");
    expect(text(await act("action", "Ran the tests."))).toContain("**active**");
    expect(text(await act("elicitation", "Deploy to prod too?"))).toContain("**awaitingInput**");

    // The delegator answers: prompt → active; the agent responds → complete.
    expect(text(await act("prompt", "Yes, deploy."))).toContain("**active**");
    expect(text(await act("response", "Shipped and deployed."))).toContain("**complete**");

    // The timeline holds all six activities in append order.
    const detail = text(await call(client, "get_agent_session", { id: sessionId }));
    expect(detail).toContain("**State**: complete");
    expect(detail).toContain("Timeline (6)");
    const positions = [
      "Please ship the thing",
      "Reading the code.",
      "Ran the tests.",
      "Deploy to prod too?",
      "Yes, deploy.",
      "Shipped and deployed.",
    ].map((needle) => detail.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // Listing filters by state + agent.
    const listed = text(
      await call(client, "list_agent_sessions", {
        state: "complete",
        agent: "worker@agents.local",
      }),
    );
    expect(listed).toContain(sessionId as string);
    expect(text(await call(client, "list_agent_sessions", { state: "pending" }))).toContain(
      "_No agent sessions._",
    );

    // Everything flowed through the one event log — no side store.
    expect(service.eventCount()).toBeGreaterThan(6);
  });

  test("append_agent_activity validates type and session ref", async () => {
    const { client } = await boot();
    await call(client, "save_issue", { team: "BRO", title: "X" });
    const created = await call(client, "create_agent_session", { issue: "BRO-1" });
    const sessionId = /`([0-9A-HJKMNP-TV-Z]{26})`/.exec(text(created))?.[1];
    const bad = await call(client, "append_agent_activity", {
      sessionId,
      type: "yelling",
      body: "?!",
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("type must be one of");
    const missing = await call(client, "append_agent_activity", {
      sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      type: "thought",
      body: "hm",
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("no agent session");
  });
});
