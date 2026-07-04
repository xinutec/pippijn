#!/usr/bin/env bash
# coach verify — rust backend (fmt + clippy) + angular frontend (build + unit
# tests) + shared rules. Backend integration tests need MariaDB; run those
# separately.
set -euo pipefail
cd "$(dirname "$0")/.."
nix develop -c bash -c '
  set -euo pipefail
  # Angular (@angular/build:application) tears down its Piscina worker pool at
  # exit; on macOS with Node 24 / libuv 1.52 that teardown intermittently trips
  # a libuv kqueue assertion ("errno == EINTR", uv__io_poll) and Abort-6s AFTER
  # "bundle generation complete" — so the build succeeds but the dist is never
  # finalised. A single-worker pool avoids the multi-worker teardown race and
  # exits cleanly; the perf cost is nil on an app this small. Harmless on Linux
  # (the race does not occur there). NOT the sandbox — reproduces unsandboxed.
  export NG_BUILD_MAX_WORKERS=1
  cargo fmt --all --check
  cargo clippy --all-targets -- -D warnings
  ( cd frontend && npm run lint && npx ng build && npm test )
'
nix run "$HOME/Code/dev-lint" -- .
