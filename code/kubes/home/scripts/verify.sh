#!/usr/bin/env bash
# home verify — wraps `npm run verify` (backend tsc + biome + vitest, frontend
# lint + vitest) + the shared rules. The toolchain (nodejs) comes from the flake
# devshell — rev-pinned via flake.lock, available without npm on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
nix develop -c npm run verify

# L2 phone-width layout harness (ui-check): build the frontend, then serve the
# dist via e2e/serve.mjs and assert no overlap/overflow at Pixel width. The
# `npm run verify` above is tsc/lint/vitest only (no ng build) — and per
# home/CLAUDE.md a real ng build is what actually runs Angular strictTemplates —
# so build here. See @xinutec/ui-harness + dev-lint/docs/layout-quality-architecture.md.
nix develop -c bash -c '
  set -euo pipefail
  # NG_BUILD_MAX_WORKERS=1 lowers (does not cure) the macOS @angular/build
  # worker-pool teardown abort; re-run verify on a spurious build abort. See the
  # fuller note in the fleet Rust+Angular apps verify.sh (e.g. life).
  export NG_BUILD_MAX_WORKERS=1
  ( cd frontend && npx ng build && npm run ui-check )
'

nix run "$HOME/Code/dev-lint" -- .
