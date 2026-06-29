#!/usr/bin/env nix-shell
#!nix-shell -i bash -p nodejs_24
# Run the full pre-commit verification — one command, no wrapper.
#
# `npm run verify` chains: typecheck (backend + frontend) →
# schema-types drift check → format → Biome lint (backend) →
# ESLint (frontend) → the vitest suite. This wrapper exists only so
# the check runs directly on a machine without npm on PATH (e.g. the
# Mac mini) — the nix-shell shebang brings its own nodejs, same as
# golden.sh and deploy.sh.
#
# Usage:
#   scripts/verify.sh          # run the full verify
#
# deploy.sh already runs `npm run verify` as its first step; this is
# for running the check on its own.
#
# Exit 0 = everything passes. Non-zero = a step failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

exec npm run verify "$@"
