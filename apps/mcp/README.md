# @kanon/mcp

A **drop-in `linear-server`-compatible MCP server** backed by the Kanon event
log. Register it under the name `linear-server`, point it at a workspace
data-repo clone, and agent prompts written against the Linear MCP keep
working — now reading and writing the git-carried Kanon log instead of Linear.

```
agent (MCP client)
      │  tools/call  save_issue { team: "BRO", title: "…" }
      ▼
@kanon/mcp  ── verbatim linear-server tool schemas ──►  KanonService (@kanon/service)
      │                                                        │ createEvent → append → commit → refresh
      ▼                                                        ▼
  markdown reply  ◄────────────────────────────────────  events/*.jsonl  (canonical log)
```

One service core, thin adapters: the MCP server and the REST rendezvous
server (`@kanon/server`) are both shells over the same `KanonService`, so an
issue created over MCP is byte-for-byte the same event as one created over
REST or the CLI.

## Run it

```jsonc
// MCP client config (Claude Code, etc.)
{
  "mcpServers": {
    "linear-server": {
      "command": "bun",
      "args": ["/abs/path/kanon/apps/mcp/src/index.ts"],
      "env": {
        "KANON_DATA_DIR": "/abs/path/workspace-data-repo",  // a `kanon init`ed git clone
        "KANON_ACTOR_TYPE": "agent",
        "KANON_ACTOR": "claude@example.com"                 // optional; defaults to git email
      }
    }
  }
}
```

`KANON_GIT_REMOTE_SYNC=1` pushes after each write and pulls periodically;
default `0` (a local agent on a local clone). Reads hit the disposable SQLite
projection; writes append + commit exactly like the CLI.

## Tools (Phase 1 — M3 BRO-1649)

Input schemas are ported **verbatim** from the live `linear-server` MCP
(`src/linear-schemas.ts` is the parity oracle; `parity.test.ts` asserts the
advertised `tools/list` equals it).

| Tool | Maps to | Notes |
|---|---|---|
| `list_issues` | `service.issues` | `assignee: "me"` → the configured actor |
| `get_issue` | `service.issueDetail` | issue + state + comments + relations |
| `save_issue` | `createIssue` / `updateIssue` + `relate` | create/update; `blocks`/`blockedBy`/`relatedTo` applied (append-only) |
| `list_teams` / `get_team` | `listTeams` / `resolveTeams` | |
| `list_projects` / `get_project` | `listProjects` / `resolveProjects` | |
| `save_project` | `createProject` | create-only in Phase 1 |
| `list_comments` / `save_comment` | `listComments` / `comment` | new top-level issue comments |
| `list_issue_statuses` | `listStates` | team workflow states |
| `list_issue_labels` | `listLabels` | |
| `list_users` | `listActors` | |
| `list_cycles` | `listModelEntities("cycle")` | Kanon doesn't schedule cycles in v1 |

Tool errors are returned as MCP `isError` results (message text), never thrown
as protocol errors, so an agent sees the reason and can recover.

## Not yet (M3 Phase 2)

Agent-session/activity platform (sessions + activity timeline, delegate-vs-
assignee, stale-session janitor), streamable-HTTP transport, relation removal,
project/comment update, comment replies, remaining Linear tools (documents,
initiatives, status updates, cycle scheduling).

## Test

```sh
bun test        # in-memory MCP client ↔ server integration + parity gate
```
