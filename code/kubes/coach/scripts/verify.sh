#!/usr/bin/env bash
# coach verify — rust backend (fmt + clippy) + angular frontend (build + unit
# tests) + shared rules. Backend integration tests need MariaDB; run those
# separately.
set -euo pipefail
cd "$(dirname "$0")/.."
nix develop -c bash -c '
  set -euo pipefail
  cargo fmt --all --check
  cargo clippy --all-targets -- -D warnings
  ( cd frontend && npm run lint && npx ng build && npm test )
'
nix run "$HOME/Code/dev-lint" -- .
