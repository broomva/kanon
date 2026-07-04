// The server-side proxy to the rendezvous server. The browser talks only to
// this route; the API key never leaves the server. Every REST call and the SSE
// stream pass straight through, so the UI stays a thin projection of the log.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE = (process.env.KANON_SERVER_URL ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const KEY = process.env.KANON_API_KEY ?? "";

async function proxy(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const suffix = path.join("/");
  const search = new URL(req.url).search;
  const target = `${BASE}/${suffix}${search}`;

  const headers = new Headers();
  headers.set("accept", req.headers.get("accept") ?? "application/json");
  if (KEY) headers.set("authorization", `Bearer ${KEY}`);

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.text();
    if (body) {
      init.body = body;
      headers.set("content-type", "application/json");
    }
  }

  const isStream = suffix.endsWith("stream");
  if (isStream) init.signal = req.signal;

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return Response.json(
      { error: `kanon server unreachable at ${BASE} — is it running?` },
      { status: 502 },
    );
  }

  if (isStream && upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
