#!/usr/bin/env bash
#
# Idempotent installer for the kanon shadow-mirror refresh timer.
# Run on the VPS (agent@ layout). Safe to re-run.
#
#   KANON_REPO   kanon checkout                 (default /home/agent/kanon)
#   ENV_FILE     the secret-bearing env file    (default /home/agent/kanon-shadow-refresh.env)
#
# First run (no env file yet) seeds the env file from the example and exits 2,
# so you fill in LINEAR_API_KEY before the timer ever starts.
#
set -euo pipefail

REPO="${KANON_REPO:-/home/agent/kanon}"
ENV_FILE="${ENV_FILE:-/home/agent/kanon-shadow-refresh.env}"
UNIT_DIR="/etc/systemd/system"
SRC="$REPO/tools/linear-import/deploy"

[ -d "$SRC" ] || { echo "no deploy dir at $SRC (is KANON_REPO right?)" >&2; exit 1; }
chmod +x "$REPO/tools/linear-import/refresh.sh"

# The env file holds the secret — never clobber an existing one.
if [ ! -f "$ENV_FILE" ]; then
  cp "$SRC/kanon-shadow-refresh.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "seeded $ENV_FILE from the example." >&2
  echo "EDIT IT: set a real LINEAR_API_KEY, then re-run this script." >&2
  exit 2
fi
if grep -q 'REPLACE_ME' "$ENV_FILE"; then
  echo "$ENV_FILE still has a placeholder LINEAR_API_KEY — set it, then re-run." >&2
  exit 2
fi
chmod 600 "$ENV_FILE"

sudo cp "$SRC/kanon-shadow-refresh.service" "$SRC/kanon-shadow-refresh.timer" "$UNIT_DIR/"
sudo systemctl daemon-reload
sudo systemctl enable --now kanon-shadow-refresh.timer

echo "installed + enabled kanon-shadow-refresh.timer"
systemctl list-timers kanon-shadow-refresh.timer --no-pager || true
