# Kanon

**An agent-native work tracker.** Kanon (Greek: κανών, *rule / measure*) is a Linear-class
system of record built for a world where the primary writers are AI agents and the humans
orchestrate — not the other way around.

## The architecture in one paragraph

The canonical store is an **attributed append-only event log**, carried as JSONL segments in
one **git data-repo per workspace**. Every store that answers queries — the SQLite cache a
CLI reads, the Postgres a server materializes, the web UI — is a **rebuildable projection**
of that log. Merge is ULID-ordered union with per-field last-write-wins and OR-Set relations:
concurrent agents can't lose writes, offline clones converge deterministically, and every
mutation permanently records *who* (human, agent, session) did *what*, on *which surface*.

```mermaid
flowchart TD
    LOG["git data-repo per workspace<br/>events/*.jsonl · append-only · ULID union merge"]
    CLI["agent clones<br/>kanon CLI + SQLite projection<br/>offline-capable, explicit sync"]
    SRV["rendezvous server<br/>REST · MCP · webhooks · SSE<br/>Postgres projection · ID allocation"]
    A["coding agents"] --> CLI
    D["dispatch daemons"] --> SRV
    H["humans (web UI)"] --> SRV
    CLI <--> LOG
    SRV <--> LOG
```

Why this shape: SQL-vs-filesystem is a false binary. Linear's own sync engine is a
per-workspace action log with everything else as projections; git-backed agent trackers
(beads) proved the ergonomics. Kanon takes the log as the first-class citizen and designs
out the operational failure modes: **no hidden sync daemon** (explicit `kanon sync`),
segments + snapshots from day one, disposable caches, and a first-class rendezvous server.

## Design commitments

- **Agents first.** `--json` everywhere, ready-work queries, grep-able state, worktree-native.
- **Attribution is structural.** Every event carries `{actorType, actorId, sessionId, surface}`.
- **Hard tenant isolation.** One workspace = one data repo. Different orgs never share a log.
- **ULIDs are keys; `TEAM-123` identifiers are display aliases** allocated at the rendezvous.
- **Convergence is tested, not assumed.** Property tests gate the merge: N clones, random
  concurrent event sets, identical projections.
- **Linear-compatible agent contract.** The MCP surface (M3) mirrors the `linear-server`
  tool names and arg shapes, so agent fleets migrate with a config swap. Issues carry both
  `assignee` (accountable human) and `delegate` (agent); agent sessions follow the
  thought / elicitation / action / response / error activity model.

## Status: M0

| Milestone | Scope | Status |
|---|---|---|
| M0 | Scaffold, event schema v1, `kanon init` / `kanon validate` | **here** |
| M1 | Core merge/replay + SQLite projection + CLI lifecycle + Linear import | next |
| M2 | Rendezvous server: REST v1, ID allocation, webhooks, event feed | planned |
| M3 | MCP parity + agent sessions/delegation | planned |
| M4 | Web UI (list/board/detail/cmd-K, SSE) | planned |
| M5 | Initiatives/status updates/documents + migration tooling | planned |

## Quick start

```sh
bun install
bun run ci          # lint + typecheck + tests + build

# create a workspace data repo
bun packages/cli/src/index.ts init ~/kanon-data-myteam --workspace myteam
bun packages/cli/src/index.ts validate ~/kanon-data-myteam
```

The event contract is language-neutral: [`packages/core/schema/event.schema.json`](packages/core/schema/event.schema.json).
Rust, Python, or anything else can read and write the log directly.

## License

[MIT](LICENSE)
