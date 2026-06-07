#!/usr/bin/env nix-shell
#!nix-shell -i bash -p nodejs_22
# Deterministic golden check (v2) — replays captured fixtures, NO prod DB.
#
# Unlike scripts/golden.sh, this needs no tunnel: every fixture under
# tests/golden/days/ carries its own input closure (row-sets + recorded
# OSM trace), so the check is a pure-function replay. Re-running it from
# any commit on the same fixture gives the same result.
#
# Usage:
#   scripts/golden-v2.sh                  # check every captured day
#   scripts/golden-v2.sh --bless          # re-derive every expected
#   scripts/golden-v2.sh --bless 2026-05-15
#
# Via npm (note the `--` so npm forwards the flags):
#   npm run golden-v2
#   npm run golden-v2 -- --bless 2026-05-15
#
# Exit 0 = every fixture matches. Exit 1 = a fixture regressed. Exit 2 =
# no corpus (capture one with scripts/capture-day-v2.sh first).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

echo "==> running golden-check-v2 (no DB)"
exec node dist/cli/golden-check-v2.js "$@"
