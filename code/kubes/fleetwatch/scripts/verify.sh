#!/usr/bin/env bash
# fleetwatch verify — rust backend (fmt + clippy) + angular frontend (build + unit
# tests + phone-width layout harness) + shared rules + type-drift gate. Backend
# integration tests need MariaDB (FLEETWATCH_TEST_DATABASE_URL); run those
# separately via scripts/dev-db.sh.
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
  # ui-check (L2 phone-width layout harness) runs after the build — it serves
  # the freshly-built dist via e2e/serve.mjs and asserts no overlap/overflow at
  # Pixel width. See code/kubes/ui-harness + dev-lint/docs/layout-quality-architecture.md.
  ( cd frontend && npm run lint && npx ng build && npm test && npm run ui-check )
'
nix run "$HOME/Code/dev-lint" -- .
