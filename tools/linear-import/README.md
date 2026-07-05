# @kanon/linear-import

One-shot **Linear → Kanon** importer. Mirrors a Linear workspace snapshot into a
Kanon data repo as append-only events; idempotent on re-runs.

```sh
# the data repo must exist first
bun packages/cli/src/index.ts init ~/kanon-data --workspace myteam

# offline, from a saved snapshot
bun tools/linear-import/src/index.ts --data-repo ~/kanon-data --fixture export.json

# live (requires LINEAR_API_KEY), capturing a replayable snapshot
bun tools/linear-import/src/index.ts --data-repo ~/kanon-data --live --save-export export.json

# flags: --dry-run (report only), --json (machine-readable summary)
```

## How identity works

- ULIDs are the entity keys; every imported entity's event data carries its
  `linearId`. Display identifiers (`BRO-1234`, `number`) are preserved verbatim
  as data — aliases, never keys.
- Re-runs rebuild `linearId → {modelId, updatedAt, archived}` by scanning the
  log and skip known entities. Issues carry a `linearUpdatedAt` watermark: a
  moved `updatedAt` emits exactly one update event; an archival flip emits an
  explicit `archive`/`unarchive` op event (ops are the only archival
  mechanism — there is no `archived` data flag).
- Unresolvable cross-references are dropped from event data but recorded in
  `summary.droppedRefs` and printed as a warning. Repair-on-resolvable is a
  follow-up.
- After a non-dry-run import, `meta.json` `displayCounters` are seeded with the
  highest imported issue number per team key, so locally minted identifiers
  continue above imported history (never `BRO-1` over an imported `BRO-1646`).

## Operational limits (read before running)

1. **Comments do not re-sync.** The export carries no comment `updatedAt`
   watermark, so a comment body edited in Linear after first import is never
   updated in Kanon.
2. **Deletions never propagate.** This is snapshot-mirror semantics: the
   importer creates, updates, archives, and unarchives. Issues, comments,
   labels, or relations deleted (or un-related) in Linear remain in the Kanon
   log untouched.
3. **Mirror-phase tool — do not mix with local writes.** Update events carry
   the full current field set (the id map keeps no per-field state, and Kanon's
   per-field LWW merge makes a full-set update equivalent to a diff). That
   means a Linear-side change will clobber *every* imported field, including
   ones you edited locally. Only run the importer against repos whose imported
   entities are not receiving local writes.
4. **Segments are routing, not ordering.** Events land in `events/YYYY-MM.jsonl`
   by their (normalized, UTC) `ts` month, but the only order that matters is
   ULID. Imports routinely append newer-ULID events into old-month files —
   segment files are never immutable.

## Shadow-mirror refresh loop

The one-shot importer becomes a **living shadow mirror** when run on a timer:
`refresh.sh` re-imports Linear into a shadow data repo on a schedule, and the
serving `kanon-server` (started with `KANON_GIT_REMOTE_SYNC=0`) picks up the
appended events on its next `KANON_RELOAD_INTERVAL` disk-reload — no restart,
no dropped SSE. This keeps the shadow current with Linear for the migration
soak + dogfood (BRO-1651) without touching the Linear→Kanon cutover.

```sh
# on the VPS (agent@ layout): seed the env, set LINEAR_API_KEY, enable the timer
tools/linear-import/deploy/install.sh          # first run seeds the env file, exits 2
$EDITOR /home/agent/kanon-shadow-refresh.env   # set a real LINEAR_API_KEY
tools/linear-import/deploy/install.sh          # installs + enables the timer

# the shadow server must reload from disk (it has no git remote to pull):
#   KANON_RELOAD_INTERVAL=60   in the server's EnvironmentFile
```

`refresh.sh` is idempotent and single-flighted (`flock`): a run that finds no
Linear delta appends nothing, and a slow run never overlaps the next tick. The
run-log is `journalctl -u kanon-shadow-refresh`, plus an optional one-line JSON
receipt per run when `KANON_REFRESH_LOG` is set (for the mirror-diff soak).

> **Same operational limits as the one-shot importer apply** (comments don't
> re-sync, deletions don't propagate, and the shadow repo must not receive
> durable local writes — imported fields are clobbered on the next refresh).

## Package layout

| File | Role |
|---|---|
| `src/types.ts` | `LinearExport` plain-JSON snapshot shape |
| `src/fetch.ts` | live pull via `@linear/sdk` (thin, defensive, not unit-tested) |
| `src/cli.ts` | strict flag parsing + fail-fast export validation |
| `src/transform.ts` | pure `LinearExport → KanonEvent[]` (all invariants live here) |
| `src/data-repo.ts` | local `loadEvents` / `buildIdMap` / `appendEvents` / `seedDisplayCounters` |
| `src/index.ts` | CLI entry point |
| `fixtures/export.small.json` | reference fixture used by the tests |
| `refresh.sh` | idempotent, single-flighted timer wrapper for the live re-import |
| `deploy/kanon-shadow-refresh.{service,timer}` | systemd oneshot + timer |
| `deploy/kanon-shadow-refresh.env.example` | env template (copy, set `LINEAR_API_KEY`, `chmod 600`) |
| `deploy/install.sh` | idempotent VPS installer for the timer |
