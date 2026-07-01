#!/usr/bin/env bash
# messages verify — rust backend (fmt + clippy) + angular frontend (lint + build
# + unit tests) + shared rules. Backend integration tests (tests/archive.rs) need
# MariaDB; run those separately. Toolchain comes from the flake devshell
# (rev-pinned via flake.lock), so it's reproducible without cargo/npm on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
nix develop -c bash -c '
  set -euo pipefail
  cargo fmt --all --check
  cargo clippy --all-targets -- -D warnings
  ( cd frontend && npm run lint && npx ng build && npm test )
'
nix run "$HOME/Code/dev-lint" -- src frontend/src
