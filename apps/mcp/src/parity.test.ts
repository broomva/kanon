/**
 * Parity gate — the server's advertised `tools/list` output must equal the
 * captured linear-server schema oracle (`linear-schemas.ts`) VERBATIM. If a
 * tool's advertised input schema drifts from Linear's, an agent prompt
 * written against linear-server would serialize args Kanon can't read — the
 * whole point of the drop-in swap. Every advertised tool must also have a
 * handler, and every schema'd tool must be advertised.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventActor } from "@kanon/core";
import { KanonService } from "@kanon/service";
import { initDataRepo } from "@kanon/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LINEAR_TOOL_SCHEMAS } from "./linear-schemas";
import { createKanonMcpServer, SERVER_NAME } from "./server";
import { TOOL_HANDLERS } from "./tools";

async function listAdvertisedTools() {
  const dir = mkdtempSync(join(tmpdir(), "kanon-mcp-parity-"));
  const actor: EventActor = { type: "agent", id: "t@example.com", surface: "mcp" };
  initDataRepo({ dir, workspace: "test", actor, git: true });
  const service = new KanonService({ dataDir: dir, gitRemoteSync: false, onWarn: () => {} });
  const server = createKanonMcpServer(service, actor);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "parity", version: "0" }, { capabilities: {} });
  await client.connect(ct);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  service.close();
  rmSync(dir, { recursive: true, force: true });
  return tools;
}

describe("linear-server parity", () => {
  test("server name is linear-server", () => {
    expect(SERVER_NAME).toBe("linear-server");
  });

  test("every schema'd tool has a handler and vice versa", () => {
    const schemaNames = Object.keys(LINEAR_TOOL_SCHEMAS).sort();
    const handlerNames = Object.keys(TOOL_HANDLERS).sort();
    expect(handlerNames).toEqual(schemaNames);
  });

  test("advertised input schemas equal the linear-server oracle verbatim", async () => {
    const tools = await listAdvertisedTools();
    const advertised = new Map(tools.map((tool) => [tool.name, tool]));
    expect([...advertised.keys()].sort()).toEqual(Object.keys(LINEAR_TOOL_SCHEMAS).sort());
    for (const [name, schema] of Object.entries(LINEAR_TOOL_SCHEMAS)) {
      const tool = advertised.get(name);
      expect(tool, `tool ${name} advertised`).toBeDefined();
      expect(tool?.description).toBe(schema.description);
      expect(tool?.inputSchema).toEqual(schema.inputSchema);
    }
  });
});
