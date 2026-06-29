#!/usr/bin/env bash
# Drift gate: regenerate the TS types and fail if the committed output changed.
# Catches a Rust API-type edit that wasn't regenerated + committed. Run in the
# dev shell (cargo on PATH); wired into the pre-push hook.
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/gen-types.sh >/dev/null
if ! git diff --quiet -- frontend/src/app/generated; then
  echo "gen-types drift: the Rust API types changed but frontend/src/app/generated/" >&2
  echo "was not regenerated. Run 'nix develop --command scripts/gen-types.sh' and commit." >&2
  git --no-pager diff --stat -- frontend/src/app/generated >&2
  exit 1
fi
echo "types in sync."
