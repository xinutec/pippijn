#!/usr/bin/env bash
# Run the full pre-commit verification.
#
# `npm run verify` chains: typecheck (backend + frontend) →
# schema-types drift check → format → Biome lint (backend) →
# ESLint (frontend) → the vitest suite; then the shared dev-lint rules.
# The toolchain (nodejs) comes from the flake devshell — rev-pinned via
# flake.lock and available without npm on PATH (e.g. the Mac mini),
# same as deploy.sh.
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

nix develop -c npm run verify "$@"
nix run "$HOME/Code/dev-lint" -- src frontend/src
