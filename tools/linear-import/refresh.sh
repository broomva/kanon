#!/usr/bin/env bash
#
# kanon shadow-mirror refresh — one idempotent Linear → Kanon re-import into the
# full-workspace shadow data repo. Meant to run on a systemd timer (see deploy/).
#
# Safe to re-run at any cadence: the importer rebuilds `linearId → modelId` from
# the existing log and SKIPS entities already imported; only real deltas (moved
# updatedAt watermarks, archival flips, new entities) append events. A run that
# finds nothing new appends nothing.
#
# This writer touches ONLY the event-log segment files (append-only). The
# running kanon-live.service picks the appended events up on its next
# KANON_RELOAD_INTERVAL disk-reload — no restart, no shared mutable state.
#
# Config (all via environment, e.g. a systemd EnvironmentFile):
#   KANON_DATA_DIR     shadow data repo to import into                 (required)
#   LINEAR_API_KEY     Linear API token for the live pull              (required)
#   KANON_REPO         path to the kanon git checkout                  (default: repo root inferred from this script)
#   BUN                path to the bun binary                          (default: bun on PATH, else ~/.bun/bin/bun)
#   KANON_REFRESH_LOG  append a one-line JSON receipt per run to this  (default: unset — journald is the log)
#
set -euo pipefail

log() { printf 'kanon-shadow-refresh: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

# --- resolve config -------------------------------------------------------
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KANON_REPO="${KANON_REPO:-$(cd "$script_dir/../.." && pwd)}"
BUN="${BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"

[ -n "${KANON_DATA_DIR:-}" ]  || die "KANON_DATA_DIR is required (the shadow data repo)"
[ -n "${LINEAR_API_KEY:-}" ]  || die "LINEAR_API_KEY is required (the live Linear pull needs it)"
[ -x "$BUN" ] || command -v "$BUN" >/dev/null 2>&1 || die "bun not found at '$BUN' (set BUN=/path/to/bun)"
[ -f "$KANON_DATA_DIR/meta.json" ] || die "$KANON_DATA_DIR is not a kanon data repo (no meta.json)"
[ -f "$KANON_REPO/tools/linear-import/src/index.ts" ] || die "KANON_REPO '$KANON_REPO' has no tools/linear-import"

# --- single-flight lock ---------------------------------------------------
# A slow import must never overlap the next timer tick (double writers racing
# the same segment file). Non-blocking: if a run is in flight, skip this tick.
lock="${KANON_REFRESH_LOCK:-${TMPDIR:-/tmp}/kanon-shadow-refresh.lock}"
exec 9>"$lock"
if ! flock -n 9; then
  log "another run holds $lock — skipping this tick"
  exit 0
fi

# --- import ---------------------------------------------------------------
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "importing Linear → $KANON_DATA_DIR (repo $KANON_REPO)"
set +e
out="$(cd "$KANON_REPO" && "$BUN" tools/linear-import/src/index.ts --data-repo "$KANON_DATA_DIR" --live --json)"
code=$?
set -e

printf '%s\n' "$out"

# Optional durable one-line receipt for the mirror-diff soak (BRO-1651 step 2).
if [ -n "${KANON_REFRESH_LOG:-}" ]; then
  TS="$ts" EXIT="$code" printf '%s' "$out" | "$BUN" -e '
    const raw = require("node:fs").readFileSync(0, "utf8").trim();
    let imp = null; try { imp = JSON.parse(raw); } catch {}
    process.stdout.write(JSON.stringify({ ts: process.env.TS, exit: Number(process.env.EXIT), import: imp }) + "\n");
  ' >> "$KANON_REFRESH_LOG" || log "warning: could not write receipt to $KANON_REFRESH_LOG"
fi

if [ "$code" -ne 0 ]; then
  die "import failed (exit $code) — see output above"
fi
log "done"
