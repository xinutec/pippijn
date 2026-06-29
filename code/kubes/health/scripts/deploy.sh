#!/usr/bin/env nix-shell
#!nix-shell -i bash -p git git-crypt gh
# Deploy the health-sync app end-to-end.
#
# Node for `npm run verify` is sourced per-command from the nixos-26.05
# channel's nodejs_24 (24.16+, see VERIFY_NODE below) because the Angular 22
# frontend build hard-requires Node >= 24.15 and the default channel's
# nodejs_22/24 are a patch too old. git/git-crypt/gh stay on the default
# channel — a 26.05 `gh` can't read the macOS keyring credential and 401s.
# (2026-06-29 Angular 21->22 + zoneless migration.)
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
	# Preserve the script's real exit status. Under `set -e`, an EXIT
	# trap whose last command fails clobbers the exit code — and on a
	# `-F` run CLEANUP_MSG_FILE is 0, so the `[[ ]]` test below is
	# false, which used to turn every successful deploy into exit 1.
	local rc=$?
	if [[ "$CLEANUP_MSG_FILE" -eq 1 && -f "$MSG_FILE" ]]; then
		rm -f "$MSG_FILE"
	fi
	return "$rc"
}
trap cleanup EXIT

# --- verify --------------------------------------------------------------
# The Angular 22 frontend build needs Node >= 24.15; source it per-command
# from the 26.05 channel so the shebang's default-channel gh keeps working.
VERIFY_NODE="nixpkgs/nixos-26.05#nodejs_24"
echo "==> [1/6] npm run verify (node from $VERIFY_NODE)"
cd "$HEALTH_DIR"
nix shell "$VERIFY_NODE" --command npm run verify

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
# Bound the CI wait. `gh run watch` polls until the run finishes — with
# no ceiling, a stuck Actions queue (a real ~5-hour stall has happened)
# would hang the deploy indefinitely. Cap it at 15 min: a normal build
# is ~1 min, so anything past 15 is wedged — fail fast, before rollout.
ci_status=0
timeout 900 gh run watch --exit-status "$RUN_ID" || ci_status=$?
if [[ $ci_status -ne 0 ]]; then
	if [[ $ci_status -eq 124 ]]; then
		echo "deploy: CI run $RUN_ID did not finish within 15 min — aborting before rollout." >&2
		echo "        Inspect or cancel it: gh run view $RUN_ID  |  gh run cancel $RUN_ID" >&2
	else
		echo "deploy: CI run $RUN_ID failed (exit $ci_status) — aborting before rollout." >&2
	fi
	exit 1
fi

# --- rollout -------------------------------------------------------------
echo "==> [6/6] rollout on isis"
ssh root@isis.xinutec.org \
	'kubectl -n health rollout restart deploy/health-auth && kubectl -n health rollout status deploy/health-auth --timeout=180s'

echo "==> done."
