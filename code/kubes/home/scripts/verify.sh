#!/usr/bin/env bash
# home verify — wraps `npm run verify` (backend tsc + biome + vitest, frontend
# lint + vitest) + the shared rules. The toolchain (nodejs) comes from the flake
# devshell — rev-pinned via flake.lock, available without npm on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
nix develop -c npm run verify
nix run "$HOME/Code/dev-lint" -- src frontend/src
