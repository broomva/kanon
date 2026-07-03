/**
 * The Kanon MCP server — advertises the `linear-server` name + the ported
 * linear-server tool surface, backed by the Kanon service core.
 *
 * Uses the low-level `Server` (not the ergonomic `McpServer`) so tool input
 * schemas are the VERBATIM Linear JSON schemas from `linear-schemas.ts` — an
 * agent's tool calls serialize identically whether they hit real Linear or
 * Kanon. Tool errors are returned as `isError` results (the MCP convention),
 * never thrown as protocol errors, so an agent sees the message and can
 * recover.
 */

import type { EventActor } from "@kanon/core";
import type { KanonService } from "@kanon/service";
import { ServiceError } from "@kanon/service";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { KANON_TOOL_SCHEMAS } from "./kanon-schemas";
import { LINEAR_TOOL_SCHEMAS, type ToolSchema } from "./linear-schemas";
import { TOOL_HANDLERS, type ToolContext } from "./tools";

export const SERVER_NAME = "linear-server";
export const SERVER_VERSION = "0.2.0";

/** The advertised surface: the Linear parity set + Kanon session extensions. */
export const ALL_TOOL_SCHEMAS: Record<string, ToolSchema> = {
  ...LINEAR_TOOL_SCHEMAS,
  ...KANON_TOOL_SCHEMAS,
};

export function createKanonMcpServer(service: KanonService, actor: EventActor): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const ctx: ToolContext = { service, actor };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(ALL_TOOL_SCHEMAS).map(([name, schema]) => ({
      name,
      description: schema.description,
      inputSchema: schema.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const handler = TOOL_HANDLERS[name as keyof typeof TOOL_HANDLERS];
    if (handler === undefined) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
      };
    }
    try {
      const text = handler((rawArgs ?? {}) as Record<string, unknown>, ctx);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const message =
        error instanceof ServiceError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  });

  return server;
}
