#!/usr/bin/env nix-shell
#!nix-shell -i bash -p git git-crypt nodejs_22 gh
# Deploy the health-sync app end-to-end.
#
# Runs `npm run verify` (typecheck + lint + tests), commits the
# staged-or-stageable changes under `code/kubes/health/`, pushes
# to main, waits for CI, then rolls out the new image on isis.
#
# Usage:
#   scripts/deploy.sh -m "commit message"
#   scripts/deploy.sh -F /path/to/message.txt
#
# The shebang pulls in git / git-crypt / nodejs / gh via nix-shell so
# you can run the script directly on macOS without a manual wrapper.
# Same pattern as ~/Code/xinutec-infra/mac-mini/fleet_health.py.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# pippijn repo root: ../../../.. from health/scripts/
# (code/kubes/health → code/kubes → code → pippijn)
PIPPIJN_DIR="$(cd "$HEALTH_DIR/../../.." && pwd)"
HEALTH_REL="code/kubes/health"

if [[ ! -d "$PIPPIJN_DIR/.git" ]]; then
	echo "deploy: expected pippijn git repo at $PIPPIJN_DIR" >&2
	exit 2
fi

# --- argument parsing ----------------------------------------------------
MSG_FILE=""
CLEANUP_MSG_FILE=0
case "${1:-}" in
	-m)
		[[ -n "${2:-}" ]] || { echo "deploy: -m requires a message" >&2; exit 2; }
		MSG_FILE=$(mktemp -t deploy-msg.XXXXXX)
		CLEANUP_MSG_FILE=1
		printf '%s\n' "$2" > "$MSG_FILE"
		;;
	-F)
		[[ -n "${2:-}" && -f "${2}" ]] || { echo "deploy: -F needs an existing file" >&2; exit 2; }
		MSG_FILE="$2"
		;;
	*)
		echo "Usage: $0 -m 'commit message' | -F message-file" >&2
		exit 2
		;;
esac

cleanup() {
	[[ "$CLEANUP_MSG_FILE" -eq 1 && -f "$MSG_FILE" ]] && rm -f "$MSG_FILE"
}
trap cleanup EXIT

# --- verify --------------------------------------------------------------
echo "==> [1/6] npm run verify"
cd "$HEALTH_DIR"
npm run verify

# --- stage health/ changes only -----------------------------------------
echo "==> [2/6] staging $HEALTH_REL"
cd "$PIPPIJN_DIR"
git add "$HEALTH_REL"

# Refuse to proceed if staged changes leak outside the health subtree.
# Catches the case where stuff in other parts of the pippijn repo was
# already staged from previous work — make it explicit.
if ! git diff --cached --quiet -- ":!${HEALTH_REL}"; then
	echo "deploy: there are staged changes outside ${HEALTH_REL}:" >&2
	git diff --cached --name-only -- ":!${HEALTH_REL}" >&2
	echo "Unstage them (git restore --staged <path>) or commit them separately." >&2
	exit 1
fi

# Nothing to commit? Exit clean rather than creating an empty commit.
if git diff --cached --quiet -- "$HEALTH_REL"; then
	echo "deploy: nothing staged under $HEALTH_REL — nothing to deploy."
	exit 0
fi

# --- commit + push -------------------------------------------------------
echo "==> [3/6] git commit"
git commit -F "$MSG_FILE"

COMMIT_SHA=$(git rev-parse HEAD)
echo "    HEAD is now $COMMIT_SHA"

echo "==> [4/6] git push origin main"
git push origin main

# --- wait for CI ---------------------------------------------------------
# Find the CI run that matches THIS commit's SHA. `gh run list --limit 1`
# would race: between push and gh-list the previous commit's run is often
# still the freshest, and gh run watch on an already-completed run exits
# in ~0 ms, which then rolls out the stale image. Poll until a run for
# our specific SHA shows up (Actions usually queues within a few seconds).
echo "==> [5/6] watching CI for $COMMIT_SHA"
cd "$HEALTH_DIR"
RUN_ID=""
for attempt in $(seq 1 30); do
	RUN_ID=$(gh run list --branch main --limit 10 --json databaseId,headSha \
		--jq ".[] | select(.headSha == \"$COMMIT_SHA\") | .databaseId" | head -1)
	if [[ -n "$RUN_ID" ]]; then
		echo "    found run $RUN_ID after $attempt attempt(s)"
		break
	fi
	sleep 2
done
if [[ -z "$RUN_ID" ]]; then
	echo "deploy: no CI run for $COMMIT_SHA appeared within ~60s" >&2
	exit 1
fi
gh run watch --exit-status "$RUN_ID"

# --- rollout -------------------------------------------------------------
echo "==> [6/6] rollout on isis"
ssh root@isis.xinutec.org \
	'kubectl -n health rollout restart deploy/health-auth && kubectl -n health rollout status deploy/health-auth --timeout=180s'

echo "==> done."
