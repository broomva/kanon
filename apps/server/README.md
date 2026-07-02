# @kanon/server — the rendezvous server

REST v1 + durable event feed + SSE + webhooks + display-ID allocation over
one workspace's git-carried event log. Hono on `Bun.serve`.

```sh
KANON_DATA_DIR=~/kanon-data-myteam \
KANON_API_KEYS="s3cret-token:carlos@example.com:human" \
bun apps/server/src/index.ts
```

## Binding contracts (inherited — violating these reintroduces closed defects)

- The **event log is canonical and git-carried**; every store is disposable
  and rebuilt from the log. The server's SQLite projection (`state.db` in the
  data repo, via `@kanon/store`) can be deleted at any time — a restart
  rebuilds identical state from a full replay.
- **ULID is the only order.** Segments are a routing convention, never
  immutable; loads always `unionMergeWithReport` every segment, and any
  conflicting duplicate warns + rebuilds (content-hash staleness detection is
  in `@kanon/store`).
- **Append is `appendFileSync` only** — durable in the log before git runs.
- **Display allocation** = meta.json O_EXCL lock + `max(watermark,
  projection max) + 1` (shared implementation in `@kanon/store`; the CLI uses
  the same one). Identifiers are never reused.
- SQLite: `busy_timeout=5000` + `BEGIN IMMEDIATE` rebuild transactions
  (already in `@kanon/store`).

## Tenancy model

**One server per workspace data repo.** `KANON_DATA_DIR` points at a git
clone the server OWNS — the workspace is derived from that clone's
`meta.json`, and requests never choose a workspace. A bearer key bound to a
different workspace's server simply does not exist here: any `/v1` request
without a key valid for THIS workspace gets the same `404 {"error":"not
found"}` as a nonexistent route, so a key valid elsewhere learns nothing —
not even that this is a Kanon server for that workspace. Run N workspaces as
N deployments with N volumes.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `KANON_DATA_DIR` | (required) | git clone of the workspace data repo (server-owned) |
| `KANON_API_KEYS` | (required) | comma-separated `key:actorId:actorType[:sessionPrefix]` |
| `KANON_GIT_REMOTE_SYNC` | `1` | `1`: push after each write commit; pull `--rebase` + refresh on startup and every interval. `0`: remote-less (tests, air-gapped) |
| `KANON_SYNC_INTERVAL` | `30` | seconds between pull cycles |
| `KANON_WEBHOOK_INTERVAL_MS` | `500` | webhook delivery-loop tick |
| `PORT` | `3000` | listen port (`0` = ephemeral) |

## Auth model

`Authorization: Bearer <key>`. Keys are static env-configured credentials
(v1 — no user accounts): each maps to the `{actorId, actorType}` every event
written through this server is attributed to, with `surface: "http"`. An
optional `sessionPrefix` stamps `sessionId: "<prefix>-<boot ulid>"` so runs
of a given daemon are distinguishable in the log. Rotate by editing the env
and restarting.

A missing, unknown, or wrong-workspace key is denied with a `404 {"error":
"not found"}` — byte-identical to a nonexistent route — never a `401`. This
resource-not-found shape keeps `/v1` invisible to anyone without a valid key,
so a key valid on another workspace's server discloses nothing.

## API

All bodies and responses are JSON. Errors are `{"error": "..."}` with:
`400` malformed input / unresolvable reference · `404` missing resource, OR
an unauthenticated `/v1` request (resource-not-found shape — see Auth model)
· `409` conflict (duplicate event id, taken team key) · `422` workspace
mismatch / unallocatable · `503` allocation-lock timeout.

| Method + path | Auth | What it does |
|---|---|---|
| `GET /healthz` | none | `{ok, workspace, eventCount, head}` |
| `POST /v1/events` | ✓ | ingest pre-built `{events: KanonEvent[]}` — each validated, workspace must match, ids must be fresh (409 on duplicates); one git commit per accepted batch; → `{appended, head}` |
| `GET /v1/sync/events?after=<ulid>&limit=<n≤1000>` | ✓ | the durable feed: merged canonical stream strictly after the cursor → `{events, head, hasMore}` |
| `GET /v1/stream` | ✓ | SSE — every new event as `data: <json>` (ingest, domain writes, periodic-pull refresh) |
| `GET /v1/issues?…` | ✓ | filters mirror `@kanon/store`: `team state assignee delegate project label priority parent updatedAfter updatedBefore query includeArchived orderBy orderDir limit offset` |
| `GET /v1/issues/:ref` | ✓ | `{issue, state, comments, relations}`; `:ref` is a ULID or `TEAM-123` |
| `POST /v1/issues` | ✓ | `{team, title, description?, priority?, estimate?, state?, assignee?, delegate?, project?, milestone?, parent?, labels?}` — allocates the display number under the meta lock → `{id, identifier, number, issue}` |
| `PATCH /v1/issues/:ref` | ✓ | `{state?, title?, description?, priority?, estimate?, assignee?, delegate?, labels?, addLabels?, removeLabels?}` — `state` accepts a type name (`started`), exact name, or ULID |
| `POST /v1/issues/:ref/comments` | ✓ | `{body}` — the key's actor entity is minted on first use |
| `POST /v1/issues/:ref/relations` | ✓ | `{type: "blocks"\|"blocked-by"\|"related", target}` — idempotent (200 + `created:false` on an existing edge) |
| `GET /v1/ready?team=` | ✓ | unblocked backlog/unstarted work — the agent queue |
| `GET /v1/teams` · `POST /v1/teams {key, name}` | ✓ | team create seeds the 7 default workflow states |
| `GET /v1/projects` · `POST /v1/projects {name, description?, targetDate?}` | ✓ | projects |
| `GET /v1/webhooks` · `POST /v1/webhooks {url, secret, resourceTypes[]}` · `DELETE /v1/webhooks/:id` | ✓ | webhook registrations — `webhook` entities in the log; secrets are never returned |

Notes:

- **Actor minting**: unknown `assignee`/`delegate` refs mint an actor entity
  (delegates default to `actorType: "agent"`) — agents can be delegated work
  before they first touch the tracker. Unknown labels are minted team-scoped.
- **Durability before response**: a `2xx` write response means the events are
  in the log (appendFileSync) and committed; push is best-effort per
  `KANON_GIT_REMOTE_SYNC` and failures are logged, never returned as errors.

## Webhooks

Registrations live in the log (`model: "webhook"`, data
`{url, secret, resourceTypes[]}`). An in-process delivery loop POSTs each new
event whose `model` is in `resourceTypes` as JSON with headers:

```
X-Kanon-Signature: <hex HMAC-SHA256(secret, body)>
X-Kanon-Event:     <model>.<op>          e.g. issue.update
X-Kanon-Delivery:  <unique id per delivery chain>
```

3 retries with exponential backoff; failures are logged and never crash the
server. Delivery is at-least-once best-effort — reconcile from
`/v1/sync/events` after downtime. Verify like:

```ts
import { createHmac } from "node:crypto";

async function verify(request: Request, secret: string): Promise<boolean> {
  const body = await request.text(); // exact bytes — verify BEFORE parsing
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const given = request.headers.get("x-kanon-signature") ?? "";
  return given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

## The standalone contract

Kanon ships no orchestrator-specific adapters — the feed + webhooks ARE the
contract. [`examples/runner/`](../../examples/runner/) is an ~80-line
reference runner: poll `/v1/sync/events` from a cursor file, and when an
issue event delegates to your actor (or transitions to a started state), run
`RUNNER_CMD` with `$KANON_ISSUE`. Any daemon/CI/cron can implement that loop.

## Deploy (Railway)

Prepared, not executed — deploying needs Railway auth.

1. **Volume**: create one and mount it (e.g. at `/data`). The data repo must
   live on it: one-time bootstrap via a shell in the service —
   `git clone <data-repo-remote> /data/<workspace>` (use an HTTPS token or a
   deploy key; the server pushes/pulls this clone). Set
   `KANON_DATA_DIR=/data/<workspace>`.
2. **Env vars**: `KANON_DATA_DIR`, `KANON_API_KEYS`, optional
   `KANON_GIT_REMOTE_SYNC` / `KANON_SYNC_INTERVAL`. Railway injects `PORT`.
3. **Deploy**: point the service at this repo; `apps/server/railway.json`
   selects the Dockerfile build (repo-root context) and the `/healthz`
   healthcheck. Or build/push the image yourself:
   `docker build -f apps/server/Dockerfile -t kanon-server .`
4. **Scale**: exactly ONE instance per workspace — the server owns its clone
   and its meta.json lock is per-filesystem. More workspaces = more services.

## Tests

```sh
cd apps/server && bun test
```

Boots real servers on ephemeral ports against temp git data repos
(remote-less, `KANON_GIT_REMOTE_SYNC=0`): auth, ingest→feed cursor
round-trips, duplicate/foreign-workspace rejection, 8-way parallel display
allocation, PATCH-by-state-type, ready/blocking, SSE, signed webhook
delivery + retry, delete-state.db rebuild equivalence, and an end-to-end
runner dispatch.
