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

## Tools

The **Linear parity set** — input schemas ported **verbatim** from the live
`linear-server` MCP (`src/linear-schemas.ts` is the parity oracle;
`parity.test.ts` asserts the advertised Linear tools equal it):

| Tool | Maps to | Notes |
|---|---|---|
| `list_issues` | `service.issues` | `assignee: "me"` → the configured actor; `"null"` → unassigned |
| `get_issue` | `service.issueDetail` | issue + state + comments + relations |
| `save_issue` | `createIssue` / `updateIssue` + `relate` / `unrelate` | create/update; `blocks`/`blockedBy`/`relatedTo` add edges, `removeBlocks`/`removeBlockedBy`/`removeRelatedTo` tombstone them; `assignee`/`delegate`/`project`/`milestone`/`parentId` are tri-state (**null clears**) |
| `list_teams` / `get_team` | `listTeams` / `resolveTeams` | |
| `list_projects` / `get_project` | `listProjects` / `resolveProjects` | |
| `save_project` | `createProject` / `updateProject` | create when no `id`, update when given one |
| `list_comments` / `save_comment` | `listComments` / `comment` / `updateComment` | top-level comments, one-level `parentId` replies, and edit-by-`id` |
| `list_issue_statuses` | `listStates` | team workflow states |
| `list_issue_labels` | `listLabels` | |
| `list_users` | `listActors` | |
| `list_initiatives` / `get_initiative` / `save_initiative` | `listInitiatives` / `resolveInitiatives` / `createInitiative` / `updateInitiative` | umbrella over projects; unique name |
| `get_status_updates` / `save_status_update` | `listStatusUpdates` / `createStatusUpdate` / `updateStatusUpdate` | health (onTrack/atRisk/offTrack) on a project or initiative; `get` returns a single by `id` else a filtered list |
| `list_documents` / `get_document` / `save_document` | `listDocuments` / `createDocument` / `updateDocument` | title + content parented to exactly one of project/issue/initiative/cycle/team; update reparents |
| `list_cycles` | `listCycles` | team-scoped; `type` = `current`/`previous`/`next` window vs now (writes are the `save_cycle`/`get_cycle` extensions below) |

The **Kanon extension set** (`src/kanon-schemas.ts`; NOT part of the Linear
oracle — these have no `linear-server` equivalent, and `parity.test.ts` asserts
they never collide with an oracle tool name):

| Tool | Maps to | Notes |
|---|---|---|
| `create_agent_session` | `createAgentSession` | delegate an issue to an agent: `pending` session + delegate seat re-pointed + optional first `prompt` activity |
| `list_agent_sessions` | `agentSessions` | filter by `issue` / `agent` / `state` |
| `get_agent_session` | `agentSessionDetail` | session + issue + the full activity timeline |
| `append_agent_activity` | `appendAgentActivity` | append to the timeline; session state moves with the activity type |
| `save_cycle` / `get_cycle` | `createCycle` / `updateCycle` / `resolveCycles` | cycle writes (Linear's MCP exposes cycles read-only via `list_cycles`) |
| `list_views` / `get_view` / `save_view` | `listSavedViews` / `createSavedView` / `updateSavedView` | Kanon-native named issue-list filters (team/state/assignee/project/label/priority/query); unique name; re-run via `list_issues` |

Tool errors are returned as MCP `isError` results (message text), never thrown
as protocol errors, so an agent sees the reason and can recover.

### Agent sessions — derived state

Session state is **derived** — it moves only via activity appends and the
server-side stale janitor, never set directly:
`thought`/`action` → `active`, `elicitation` → `awaitingInput`, `prompt` (an
elicitation answer or follow-up) → `active`, `response` → `complete`,
`error` → `error`. There is deliberately no "set state" tool. The
stale-session janitor runs in the rendezvous server (`@kanon/server`), not the
stdio MCP — see its README. The [`@kanon/server`](../server/README.md) also
mounts this same tool surface over streamable HTTP at `/mcp`.

## Not yet

Cursor pagination and the remaining Linear concepts Kanon doesn't yet model
(releases). Cycles are modelled read-only via `list_cycles` plus the Kanon
extensions `save_cycle` / `get_cycle`.

## Test

```sh
bun test        # in-memory MCP client ↔ server integration + parity gate
```
