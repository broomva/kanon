#!/usr/bin/env bun

/**
 * @kanon/mcp — the Kanon MCP server entry point (stdio transport).
 *
 * Register it under the name `linear-server` in an MCP client config and
 * point KANON_DATA_DIR at a workspace data-repo clone; agent prompts written
 * against the Linear MCP keep working, now backed by the Kanon event log.
 *
 *   {
 *     "mcpServers": {
 *       "linear-server": {
 *         "command": "bun",
 *         "args": ["/abs/path/kanon/apps/mcp/src/index.ts"],
 *         "env": { "KANON_DATA_DIR": "/abs/path/data-repo", "KANON_ACTOR_TYPE": "agent" }
 *       }
 *     }
 *   }
 */

import { KanonService } from "@kanon/service";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config";
import { createKanonMcpServer } from "./server";

export { ConfigError, loadConfig, type McpConfig, resolveActor } from "./config";
export { LINEAR_TOOL_SCHEMAS } from "./linear-schemas";
export { createKanonMcpServer, SERVER_NAME, SERVER_VERSION } from "./server";
export { TOOL_HANDLERS } from "./tools";

export async function main(): Promise<void> {
  const config = loadConfig();
  const service = new KanonService({
    dataDir: config.dataDir,
    gitRemoteSync: config.gitRemoteSync,
    // stderr only — stdout is the JSON-RPC channel and must stay clean.
    onWarn: (message) => console.error(message),
  });
  const server = createKanonMcpServer(service, config.actor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Boot line on stderr so it never corrupts the stdio JSON-RPC stream.
  console.error(
    `kanon-mcp: linear-server-compatible surface for workspace "${service.workspace}" ` +
      `(${service.eventCount()} events) — actor ${config.actor.id}`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("kanon-mcp: fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
