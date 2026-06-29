#!/usr/bin/env bash
# Install the shared kubes git hooks into this clone's .git/hooks. Idempotent;
# only touches the hooks it manages, leaving others alone. Run once per clone.
#   - pre-commit: dev-lint custom rules on whichever app a commit touches (all apps)
#   - pre-push:   life's slower type-drift + frontend tests
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
ln -sf "$root/code/kubes/scripts/githooks/pre-commit" "$root/.git/hooks/pre-commit"
ln -sf "$root/code/kubes/scripts/githooks/pre-push" "$root/.git/hooks/pre-push"
echo "installed hooks → code/kubes/scripts/githooks/ (pre-commit: dev-lint; pre-push: life tests)"
