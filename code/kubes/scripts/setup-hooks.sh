#!/usr/bin/env bash
# Install the shared kubes git hooks into this clone's .git/hooks. Idempotent;
# only touches the hooks it manages, leaving others alone. Run once per clone.
#   - pre-commit: type-aware frontend lint for staged apps (messages) — LOCAL gate
#   - pre-push:   dev-lint on whichever app a push touches (health, home, …)
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
ln -sf "$root/code/kubes/scripts/githooks/pre-commit" "$root/.git/hooks/pre-commit"
ln -sf "$root/code/kubes/scripts/githooks/pre-push" "$root/.git/hooks/pre-push"
echo "installed hooks → code/kubes/scripts/githooks/ (pre-commit: type-aware lint; pre-push: dev-lint)"
