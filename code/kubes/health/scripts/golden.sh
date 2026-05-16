#!/usr/bin/env nix-shell
#!nix-shell -i bash -p openssh nodejs_22
# Run the golden-day regression check against prod data — one command.
#
# Builds the project locally, then runs golden-check.js against the
# prod health-db via scripts/prod-db.sh (which opens the tunnel and
# exports the DB env). Because it runs the locally-built code, the
# check sees whatever pipeline changes you have made — that is the
# point: catch regressions before they ship.
#
# Usage:
#   scripts/golden.sh                  # check every day in the manifest
#   scripts/golden.sh --bless          # re-bless every day
#   scripts/golden.sh --bless 2026-05-15   # re-bless one day
#
# Via npm (note the `--` so npm forwards the flags):
#   npm run golden
#   npm run golden -- --bless 2026-05-15
#
# Exit 0 = every day matches its baseline. Exit 1 = a day regressed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

echo "==> running golden-check against prod"
exec "$SCRIPT_DIR/prod-db.sh" node dist/cli/golden-check.js "$@"
