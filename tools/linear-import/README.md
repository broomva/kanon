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

`refresh.sh` is idempotent and single-flighted: a run that finds no Linear delta
appends nothing, and the `flock` guard stops one refresh from overlapping the
next (refresh-vs-refresh only — it does not coordinate with the server's reader).
The server-vs-writer race is benign by design: appends are append-only and
merged by ULID, and if a reload happens to read a partially-written tail, that
tick's `loadLog` throws, the reload is skipped, and the next tick re-reads the
now-complete file — `this.log` is only ever replaced on a clean load. The
run-log is `journalctl -u kanon-shadow-refresh`, plus an optional one-line JSON
receipt per run (`{ts, exit, import}`) when `KANON_REFRESH_LOG` is set (for the
mirror-diff soak).

> **Same operational limits as the one-shot importer apply** (comments don't
> re-sync, deletions don't propagate, and the shadow repo must not receive
> durable local writes — imported fields are clobbered on the next refresh).

## Mirror-diff soak (does the shadow match Linear?)

The refresh loop keeps the shadow *current*; the **mirror-diff** proves it is
*correct* — the read-only gate for the cutover (BRO-1651 step 2). It compares
each system via its own read path — live Linear (`@linear/sdk`) vs the shadow's
REST `:8793` — joined on `data.linearId`, and reports whether every issue's
title / state / priority / assignee / project / labels / archived match.

```sh
# one-shot check (exit 0 converged · 1 diverged · 2 error)
KANON_API_KEY=<shadow-bearer> LINEAR_API_KEY=lin_… \
  bun tools/linear-import/src/diff-cli.ts --json

# 48h soak on the VPS: every 6h, receipt appended to ~/kanon-mirror-diff.jsonl
tools/linear-import/deploy/install-diff.sh          # first run seeds the env, exits 2
$EDITOR /home/agent/kanon-mirror-diff.env           # LINEAR_API_KEY + KANON_API_KEY
tools/linear-import/deploy/install-diff.sh          # installs + enables the timer
```

**Convergence gate:** `converged = onlyInLinear == 0 && field-mismatches == 0`.
Known-limit divergences are **reported, not hard-failed** — a description-only
diff (soft) and `onlyInKanon` (an issue deleted in Linear, or absent from the
pull) show in the report but don't flip `converged`. Nothing is written to
either system.

**Reading the soak (not "every receipt must be green").** The diff and the
refresh run on independent timers, so a single non-converged receipt is
*expected* during active work: an issue edited in Linear is drift until the
next refresh (≤30 min) catches it, and a mid-flight edit during the multi-minute
Linear pull shows as drift for one run. Such transients **self-heal on the next
diff**. The soak is green when, over the 48h window:

1. the **receipt count matches the expected run count** (≈8 at 6h cadence, plus
   catch-ups) — a *missing* receipt means a run errored (exit 2), not that it
   converged, so a short count fails the gate; **and**
2. no drift **persists across ≥2 consecutive diffs** (i.e. survives a refresh
   cycle). A mismatch on the same issue in back-to-back receipts is real
   divergence and blocks the cutover; an isolated one-run blip is refresh lag.

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
| `src/diff.ts` | pure mirror-diff core — normalize both sides to linearId space + `diffIssues` |
| `src/diff-cli.ts` | fetch live Linear + shadow REST, run the diff, report + receipt (read-only) |
| `refresh.sh` | idempotent, single-flighted timer wrapper for the live re-import |
| `deploy/kanon-shadow-refresh.{service,timer}` | refresh systemd oneshot + timer |
| `deploy/kanon-mirror-diff.{service,timer}` | mirror-diff soak systemd oneshot + timer |
| `deploy/*.env.example` | env templates (copy, set secrets, `chmod 600`) |
| `deploy/install.sh` / `install-diff.sh` | idempotent VPS installers (refresh / diff) |
