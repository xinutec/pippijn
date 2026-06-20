#!/usr/bin/env bash
# Install the health-sync pre-push hook into this repo's .git/hooks.
# Idempotent; only touches pre-push (leaves other hooks alone). Run once per
# clone. The hook runs the shared dev-lint custom rules on health-sync pushes;
# see scripts/githooks/pre-push.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
ln -sf "$root/code/kubes/health/scripts/githooks/pre-push" "$root/.git/hooks/pre-push"
echo "installed pre-push hook → code/kubes/health/scripts/githooks/pre-push"
