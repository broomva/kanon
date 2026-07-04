/**
 * HTTP surface — thin Hono routes over the KanonService funnel. Routes
 * parse HTTP (params, bodies, auth) and delegate; ALL validation, event
 * creation, appending, and broadcasting lives in service.ts.
 *
 * Tenancy: the workspace is derived from the data repo's meta.json —
 * requests NEVER choose a workspace. One server per workspace data repo.
 * Any /v1 request without a key valid for THIS workspace gets the SAME 404
 * as a nonexistent route (resource-not-found shape): a key valid on another
 * workspace's server learns nothing — not even that this is a Kanon server
 * for that workspace (BRO-1648 AC#2).
 */

import { StreamableHTTPTransport } from "@hono/mcp";
import { type EventActor, type KanonEvent, type Surface, ulid } from "@kanon/core";
import { createKanonMcpServer } from "@kanon/mcp";
import { type KanonService, ServiceError } from "@kanon/service";
import { MetaLockError } from "@kanon/store";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiKeyPrincipal, ServerConfig } from "./config";

export type AppEnv = { Variables: { actor: EventActor } };

function principalActor(principal: ApiKeyPrincipal, bootId: string, surface: Surface): EventActor {
  return {
    type: principal.actorType,
    id: principal.actorId,
    surface,
    ...(principal.sessionPrefix !== undefined
      ? { sessionId: `${principal.sessionPrefix}-${bootId}` }
      : {}),
  };
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ServiceError(400, "body must be valid JSON");
  }
}

export function createApp(service: KanonService, config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // One session-id suffix per server process: `sessionPrefix-<bootId>`.
  const bootId = ulid();

  app.onError((error, c) => {
    if (error instanceof ServiceError) {
      return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    }
    if (error instanceof MetaLockError) {
      return c.json({ error: error.message }, 503);
    }
    console.error("kanon-server: unhandled error:", error);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  // -- health (no auth) -------------------------------------------------------
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      workspace: service.workspace,
      eventCount: service.eventCount(),
      head: service.head(),
    }),
  );

  // -- bearer auth for /v1 and /mcp ---------------------------------------------
  // Non-disclosure by design (BRO-1648 AC#2): a missing key, an unknown key,
  // and a key valid on ANOTHER workspace's server all collapse to the SAME
  // 404 as a nonexistent route (`c.notFound()` → the app's notFound handler).
  // Protected routes are therefore invisible — the denial is byte-identical
  // to "no such resource", so a caller learns nothing (not even that this is
  // a Kanon server for this workspace). One denial response is what makes the
  // non-disclosure airtight; a 401 would confirm the server + auth surface.
  const bearerPrincipal = (c: { req: { header(name: string): string | undefined } }) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    return token === undefined || token.length === 0 ? undefined : config.apiKeys.get(token);
  };
  app.use("/v1/*", async (c, next) => {
    const principal = bearerPrincipal(c);
    if (principal === undefined) {
      return c.notFound();
    }
    c.set("actor", principalActor(principal, bootId, "http"));
    await next();
  });

  // -- MCP over streamable HTTP ---------------------------------------------
  // The same linear-server-compatible surface the stdio MCP serves, mounted
  // on the rendezvous server so one deployment exposes REST + SSE + MCP.
  // Stateless per-request transport: a fresh Server bound to the caller's
  // actor (events written over MCP attribute to the API key's principal,
  // surface "mcp"), same 404-shaped denial as /v1.
  app.all("/mcp", async (c) => {
    const principal = bearerPrincipal(c);
    if (principal === undefined) {
      return c.notFound();
    }
    const server = createKanonMcpServer(service, principalActor(principal, bootId, "mcp"));
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return (await transport.handleRequest(c)) ?? c.notFound();
  });

  // -- event transport ----------------------------------------------------------
  app.post("/v1/events", async (c) => c.json(service.ingest(await jsonBody(c.req.raw)), 201));

  app.get("/v1/sync/events", (c) =>
    c.json(service.feed(c.req.query("after"), c.req.query("limit"))),
  );

  app.get("/v1/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: KanonEvent[] = [];
      let open = true;
      let wake: (() => void) | undefined;
      const unsubscribe = service.bus.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ workspace: service.workspace, head: service.head() }),
      });
      while (open) {
        while (open) {
          const event = queue.shift();
          if (event === undefined) break;
          await stream.writeSSE({ id: event.id, data: JSON.stringify(event) });
        }
        if (!open) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    }),
  );

  // -- issues ---------------------------------------------------------------------
  app.get("/v1/issues", (c) => c.json({ issues: service.issues(c.req.query()) }));

  app.get("/v1/ready", (c) => c.json({ issues: service.ready(c.req.query("team")) }));

  app.get("/v1/issues/:ref", (c) => c.json(service.issueDetail(c.req.param("ref"))));

  app.post("/v1/issues", async (c) =>
    c.json(service.createIssue(c.get("actor"), await jsonBody(c.req.raw)), 201),
  );

  app.patch("/v1/issues/:ref", async (c) =>
    c.json({
      issue: service.updateIssue(c.get("actor"), c.req.param("ref"), await jsonBody(c.req.raw)),
    }),
  );

  app.post("/v1/issues/:ref/comments", async (c) =>
    c.json(
      { comment: service.comment(c.get("actor"), c.req.param("ref"), await jsonBody(c.req.raw)) },
      201,
    ),
  );

  app.post("/v1/issues/:ref/relations", async (c) => {
    const result = service.relate(c.get("actor"), c.req.param("ref"), await jsonBody(c.req.raw));
    return c.json(result, result.created ? 201 : 200);
  });

  app.delete("/v1/issues/:ref/relations", async (c) => {
    const result = service.unrelate(c.get("actor"), c.req.param("ref"), await jsonBody(c.req.raw));
    return c.json(result, 200);
  });

  // -- agent sessions + activities (M3 Phase 2) --------------------------------
  app.get("/v1/agent-sessions", (c) => c.json({ sessions: service.agentSessions(c.req.query()) }));

  app.post("/v1/agent-sessions", async (c) =>
    c.json(service.createAgentSession(c.get("actor"), await jsonBody(c.req.raw)), 201),
  );

  app.get("/v1/agent-sessions/:ref", (c) => c.json(service.agentSessionDetail(c.req.param("ref"))));

  app.post("/v1/agent-sessions/:ref/activities", async (c) =>
    c.json(
      service.appendAgentActivity(c.get("actor"), c.req.param("ref"), await jsonBody(c.req.raw)),
      201,
    ),
  );

  // -- catalog (web-UI bootstrap: resolve stateId/labelIds/actor refs) ---------
  app.get("/v1/catalog", (c) => c.json(service.catalog()));

  // -- teams + projects --------------------------------------------------------
  app.get("/v1/teams", (c) => c.json({ teams: service.listTeams() }));

  app.post("/v1/teams", async (c) =>
    c.json(service.createTeam(c.get("actor"), await jsonBody(c.req.raw)), 201),
  );

  app.get("/v1/projects", (c) => c.json({ projects: service.listProjects() }));

  app.post("/v1/projects", async (c) =>
    c.json({ project: service.createProject(c.get("actor"), await jsonBody(c.req.raw)) }, 201),
  );

  // -- webhooks -----------------------------------------------------------------
  app.get("/v1/webhooks", (c) => c.json({ webhooks: service.listWebhooks() }));

  app.post("/v1/webhooks", async (c) =>
    c.json({ webhook: service.createWebhook(c.get("actor"), await jsonBody(c.req.raw)) }, 201),
  );

  app.delete("/v1/webhooks/:id", (c) =>
    c.json(service.deleteWebhook(c.get("actor"), c.req.param("id"))),
  );

  return app;
}
