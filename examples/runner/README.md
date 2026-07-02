# Reference runner — the standalone dispatch contract

Kanon ships **no orchestrator-specific adapters**. The durable event feed
(`GET /v1/sync/events`) and webhooks ARE the contract: anything that can poll
an HTTP endpoint — a daemon, a CI job, a cron entry, a systemd timer — can
dispatch agents from Kanon. `run.ts` (~80 lines, zero dependencies) is the
proof.

## The loop

1. Read a cursor (last-seen event ULID) from a local file.
2. `GET /v1/sync/events?after=<cursor>&limit=500` with a bearer key.
3. The feed is the FULL canonical stream, so the runner derives its own
   lookup tables as it reads: team keys (`team` events), started-type
   workflow states (`workflow_state` events with `data.type === "started"`),
   its own actor-entity ids (`actor` events whose `name`/`email` match
   `RUNNER_ACTOR`), and issue display numbers (`issue` events).
4. When an `issue` create/update event has `data.delegateId` matching this
   runner's actor OR `data.stateId` in a started-type state, execute
   `RUNNER_CMD` with `$KANON_ISSUE` substituted (via the shell environment).
5. Persist the cursor after each batch; repeat every `RUNNER_POLL_MS`.

Crash-safe by construction: the cursor file is the only state, and
re-processing an event chain from an older cursor merely re-derives the same
lookup tables (execute-side idempotency is the runner's own concern — dedupe
on `$KANON_ISSUE` if your command is not idempotent).

## Run it

```sh
KANON_URL=http://localhost:3000 \
KANON_API_KEY=<key> \
RUNNER_ACTOR=claude-runner \
RUNNER_CMD='claude -p "work on issue $KANON_ISSUE"' \
bun examples/runner/run.ts
```

| Env | Default | Meaning |
|---|---|---|
| `KANON_URL` | (required) | rendezvous server base URL |
| `KANON_API_KEY` | (required) | bearer key (see server README auth model) |
| `RUNNER_ACTOR` | `runner` | actor name/email this runner answers delegations for |
| `RUNNER_CMD` | (required) | shell command template; `$KANON_ISSUE` is the display identifier (e.g. `BRO-12`) or issue ULID |
| `RUNNER_POLL_MS` | `2000` | poll interval |
| `RUNNER_CURSOR_FILE` | `.kanon-runner-cursor` | cursor persistence path |

To delegate work to it:

```sh
curl -X POST "$KANON_URL/v1/issues" \
  -H "authorization: Bearer $KANON_API_KEY" -H "content-type: application/json" \
  -d '{"team": "BRO", "title": "Fix the flaky test", "delegate": "claude-runner"}'
```

## Not a poller? Use webhooks

Register `POST /v1/webhooks {url, secret, resourceTypes: ["issue"]}` and
receive each matching event as a signed JSON POST
(`X-Kanon-Signature: hex HMAC-SHA256(secret, body)`) instead of polling.
The feed remains the durable source — webhooks are at-least-once
best-effort; reconcile from `/v1/sync/events` after downtime.
