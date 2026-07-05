#!/usr/bin/env bash
# coach verify — rust backend (fmt + clippy) + angular frontend (build + unit
# tests) + shared rules. Backend integration tests need MariaDB; run those
# separately.
set -euo pipefail
cd "$(dirname "$0")/.."
nix develop -c bash -c '
  set -euo pipefail
  # @angular/build:application tears down its Piscina worker pool at process
  # exit; on macOS / Node 24 / libuv 1.52 that teardown intermittently aborts
  # the process — a libuv kqueue assertion ("errno == EINTR", uv__io_poll →
  # Abort 6) or "EBADF: bad file descriptor, close" — AFTER "bundle generation
  # complete", i.e. once a complete, valid bundle is already on disk.
  # NG_BUILD_MAX_WORKERS=1 lowers the rate (fewer worker pipes to race) but does
  # NOT eliminate it; a spurious build abort here is worked around by re-running
  # verify. Harmless on Linux/CI, which build cleanly. NOT the sandbox.
  export NG_BUILD_MAX_WORKERS=1
  cargo fmt --all --check
  cargo clippy --all-targets -- -D warnings
  # ui-check (L2 phone-width layout harness) runs after the build — it serves
  # the freshly-built dist via e2e/serve.mjs and asserts no overlap/overflow at
  # Pixel width. See @xinutec/ui-harness + dev-lint/docs/layout-quality-architecture.md.
  ( cd frontend && npm run lint && npx ng build && npm test && npm run ui-check )
'
nix run "$HOME/Code/dev-lint" -- .
