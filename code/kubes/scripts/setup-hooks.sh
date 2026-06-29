#!/usr/bin/env bash
# Install the shared kubes pre-push hook into this clone's .git/hooks. It runs
# dev-lint on whichever app a push touches (health, home, …). Idempotent; only
# touches pre-push, leaving other hooks alone. Run once per clone.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
ln -sf "$root/code/kubes/scripts/githooks/pre-push" "$root/.git/hooks/pre-push"
echo "installed pre-push hook → code/kubes/scripts/githooks/pre-push (health, home)"
