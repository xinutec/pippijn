#!/usr/bin/env bash
# Point git at the version-controlled hooks (one-time, per clone).
#
# `core.hooksPath` rather than the symlink into .git/hooks that the old
# code/kubes/scripts/setup-hooks.sh installed: a symlink is per-clone state that
# nothing checks, and the one it left behind pointed at a hook that had stopped
# doing anything.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath scripts/githooks
echo "git hooks installed: core.hooksPath = scripts/githooks (pre-commit runs gate.json)"
