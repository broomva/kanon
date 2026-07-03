/**
 * Parity gate — three independent checks:
 *
 *  1. CONTRACT vs the external oracle. `fixtures/linear-server-tools.json` is
 *     the arg contract (property names + types + enums + required) captured
 *     from the LIVE linear-server. We assert the served schemas match it, so
 *     an edit to `linear-schemas.ts` that drifts from Linear's contract fails
 *     here — the check is against a separate captured artifact, not against
 *     the module itself (which would be tautological). Descriptions/defaults
 *     are excluded on purpose: they're agent-facing prose, not the wire
 *     contract that decides whether a Linear-shaped call deserializes.
 *  2. RUNTIME fidelity. The server's advertised `tools/list` equals the
 *     `linear-schemas.ts` module verbatim (no runtime drift in `server.ts`).
 *  3. COVERAGE. Every schema'd tool has a handler and vice versa.
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
import oracle from "../fixtures/linear-server-tools.json" with { type: "json" };
import { LINEAR_TOOL_SCHEMAS } from "./linear-schemas";
import { createKanonMcpServer, SERVER_NAME } from "./server";
import { TOOL_HANDLERS } from "./tools";

interface Contract {
  required: string[];
  props: Record<string, { type?: string; enum?: string[] }>;
}

/** Reduce a JSON Schema to the wire contract: prop → {type?, enum?}, sorted required. */
function contractOf(inputSchema: {
  properties: Record<string, unknown>;
  required?: string[];
}): Contract {
  const props: Record<string, { type?: string; enum?: string[] }> = {};
  for (const [name, raw] of Object.entries(inputSchema.properties)) {
    const spec = raw as { type?: string; enum?: string[] };
    props[name] = {
      ...(spec.type !== undefined ? { type: spec.type } : {}),
      ...(spec.enum !== undefined ? { enum: spec.enum } : {}),
    };
  }
  return { required: [...(inputSchema.required ?? [])].sort(), props };
}

const ORACLE = oracle.tools as Record<string, Contract>;

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
    expect(Object.keys(TOOL_HANDLERS).sort()).toEqual(Object.keys(LINEAR_TOOL_SCHEMAS).sort());
  });

  test("served tool contract matches the captured linear-server oracle", () => {
    // Same tool set as the oracle.
    expect(Object.keys(LINEAR_TOOL_SCHEMAS).sort()).toEqual(Object.keys(ORACLE).sort());
    // Each tool's arg contract (names/types/enums/required) equals the oracle.
    for (const [name, schema] of Object.entries(LINEAR_TOOL_SCHEMAS)) {
      const expected = ORACLE[name];
      expect(expected, `oracle has ${name}`).toBeDefined();
      expect(contractOf(schema.inputSchema), `contract for ${name}`).toEqual(expected as Contract);
    }
  });

  test("advertised tools/list equals the module verbatim (no runtime drift)", async () => {
    const tools = await listAdvertisedTools();
    const advertised = new Map(tools.map((tool) => [tool.name, tool]));
    expect([...advertised.keys()].sort()).toEqual(Object.keys(LINEAR_TOOL_SCHEMAS).sort());
    for (const [name, schema] of Object.entries(LINEAR_TOOL_SCHEMAS)) {
      const tool = advertised.get(name);
      expect(tool?.description).toBe(schema.description);
      expect(tool?.inputSchema).toEqual(schema.inputSchema);
    }
  });
});
