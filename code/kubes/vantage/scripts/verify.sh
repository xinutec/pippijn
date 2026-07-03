#!/usr/bin/env bash
# vantage verify — rust backend (fmt + clippy) + angular frontend (build + unit
# tests) + shared rules + type-drift gate. Backend integration tests need
# MariaDB (VANTAGE_TEST_DATABASE_URL); run those separately via scripts/dev-db.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
nix develop -c bash -c '
  set -euo pipefail
  cargo fmt --all --check
  cargo clippy --all-targets -- -D warnings
  # Regenerate the TS types and fail if the committed output drifted.
  scripts/gen-types.sh
  if ! git diff --quiet -- frontend/src/app/generated; then
    echo "generated types are stale — run scripts/gen-types.sh and commit" >&2
    git --no-pager diff -- frontend/src/app/generated >&2
    exit 1
  fi
  ( cd frontend && npm run lint && npx ng build && npm test )
'
nix run "$HOME/Code/dev-lint" -- .
