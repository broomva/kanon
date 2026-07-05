#!/usr/bin/env bash
#
# Idempotent installer for the kanon mirror-diff soak timer (BRO-1651 step 2).
# Run on the VPS (agent@ layout). Safe to re-run. Read-only — installs the
# convergence-check timer; it never performs the cutover.
#
#   KANON_REPO   kanon checkout   (default /home/agent/kanon)
#
# ENV_FILE is fixed to /home/agent/kanon-mirror-diff.env — the SAME path the
# systemd unit reads (EnvironmentFile=). It is deliberately NOT overridable, so
# the file the installer seeds/validates can never diverge from the one the
# timer uses.
#
# First run (no env file yet) seeds it from the example and exits 2, so you fill
# in LINEAR_API_KEY + KANON_API_KEY before the timer starts.
#
set -euo pipefail

REPO="${KANON_REPO:-/home/agent/kanon}"
ENV_FILE="/home/agent/kanon-mirror-diff.env" # must match the unit's EnvironmentFile
UNIT_DIR="/etc/systemd/system"
SRC="$REPO/tools/linear-import/deploy"

[ -d "$SRC" ] || { echo "no deploy dir at $SRC (is KANON_REPO right?)" >&2; exit 1; }

if [ ! -f "$ENV_FILE" ]; then
  cp "$SRC/kanon-mirror-diff.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "seeded $ENV_FILE from the example." >&2
  echo "EDIT IT: set LINEAR_API_KEY + KANON_API_KEY, then re-run this script." >&2
  exit 2
fi
# Both secrets must be present AND non-empty (a blank/misspelled key would pass a
# REPLACE_ME-only check and then fail on every timer run).
for key in LINEAR_API_KEY KANON_API_KEY; do
  val="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
  if [ -z "$val" ] || [ "$val" = "REPLACE_ME" ] || [ "$val" = "lin_xxx_REPLACE_ME" ]; then
    echo "$ENV_FILE: $key is missing, empty, or a placeholder — set it, then re-run." >&2
    exit 2
  fi
done
chmod 600 "$ENV_FILE"

sudo cp "$SRC/kanon-mirror-diff.service" "$SRC/kanon-mirror-diff.timer" "$UNIT_DIR/"
sudo systemctl daemon-reload
sudo systemctl enable --now kanon-mirror-diff.timer

echo "installed + enabled kanon-mirror-diff.timer"
systemctl list-timers kanon-mirror-diff.timer --no-pager || true
