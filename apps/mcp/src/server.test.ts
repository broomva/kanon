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

  test("save_issue null-to-remove is rejected, not silently ignored", async () => {
    const { client } = await boot();
    await call(client, "save_issue", {
      team: "BRO",
      title: "Assigned",
      assignee: "bob@example.com",
    });
    const result = await call(client, "save_issue", { id: "BRO-1", assignee: null });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Phase 2");
    // The assignee was NOT cleared (no phantom success).
    expect(text(await call(client, "get_issue", { id: "BRO-1" }))).toContain("bob");
  });
});
