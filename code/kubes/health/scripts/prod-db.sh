#!/usr/bin/env nix-shell
#!nix-shell -i bash -p openssh nodejs_22
# Run a command with a tunnel open to the prod health-db.
#
# Opens an SSH-forwarded connection to the prod MariaDB and exports the
# env a health-sync CLI needs — DB_HOST/PORT/USER/PASSWORD/NAME,
# NC_CLIENT_ID/SECRET, NC_BASE_URL, TZ=UTC — pulled live from the
# running pod. Then runs the given command and tears the tunnel down.
#
# Usage:
#   scripts/prod-db.sh node dist/cli/analyze-day.js 2026-05-15 pippijn Europe/London
#   scripts/prod-db.sh node dist/cli/golden-check.js
#   scripts/prod-db.sh node /tmp/some-diagnostic.mjs
#
# The command runs locally against 127.0.0.1:13306 -(ssh)-
# svc/health-db:3306. Build the project yourself first if the command
# needs dist/. TZ is pinned to UTC so a local run matches prod (the
# classification pipeline is not timezone-pure).
#
# Wrapper chatter goes to stderr, so the command's stdout stays clean.
# The shebang pulls ssh / node via nix-shell — same pattern as
# scripts/deploy.sh.

set -euo pipefail

[ "$#" -ge 1 ] || {
	echo "usage: prod-db.sh <command...>" >&2
	exit 2
}

HEALTH_HOST=root@isis.xinutec.org
NS=health
LOCAL_PORT=13306

echo "==> fetching DB credentials from prod" >&2
POD=$(ssh "$HEALTH_HOST" "kubectl -n $NS get pods -l app=health-auth -o jsonpath='{.items[0].metadata.name}'")
[ -n "$POD" ] || {
	echo "could not find a health-auth pod" >&2
	exit 1
}
# One round-trip: dump the pod env, pick out the vars locally. Captured
# into a shell var — never echoed.
ENVDUMP=$(ssh "$HEALTH_HOST" "kubectl -n $NS exec $POD -- printenv")
get() { printf '%s\n' "$ENVDUMP" | grep "^$1=" | head -1 | cut -d= -f2- || true; }
DB_USER=$(get DB_USER)
DB_PASSWORD=$(get DB_PASSWORD)
DB_NAME=$(get DB_NAME)
NC_BASE_URL=$(get NC_BASE_URL)
NC_CLIENT_ID=$(get NC_CLIENT_ID)
NC_CLIENT_SECRET=$(get NC_CLIENT_SECRET)
[ -n "$DB_PASSWORD" ] || {
	echo "DB_PASSWORD not found in pod env" >&2
	exit 1
}
export DB_USER DB_PASSWORD DB_NAME NC_CLIENT_ID NC_CLIENT_SECRET
export DB_HOST=127.0.0.1 DB_PORT="$LOCAL_PORT" TZ=UTC
# NC_BASE_URL is usually unset in the pod (the app falls back to a
# built-in default). Only export it when prod actually sets it —
# exporting an empty string would fail URL validation.
[ -n "$NC_BASE_URL" ] && export NC_BASE_URL || true

echo "==> opening tunnel to prod health-db" >&2
# The [k]ubectl bracket keeps this pattern from matching its own pkill
# command line, so cleanup only kills real kubectl port-forwards.
PF_PATTERN="[k]ubectl.*port-forward svc/health-db $LOCAL_PORT"
cleanup() {
	kill "${TUNNEL_PID:-}" 2>/dev/null || true
	ssh "$HEALTH_HOST" "pkill -f '$PF_PATTERN' 2>/dev/null || true" 2>/dev/null || true
}
trap cleanup EXIT
# Clear any forward left behind by an interrupted earlier run, then
# open a fresh one: Mac:LOCAL_PORT -(ssh -L)- isis:LOCAL_PORT
# -(kubectl)- svc/health-db:3306.
ssh "$HEALTH_HOST" "pkill -f '$PF_PATTERN' 2>/dev/null || true" 2>/dev/null || true
ssh -o ExitOnForwardFailure=yes -L "$LOCAL_PORT:127.0.0.1:$LOCAL_PORT" "$HEALTH_HOST" \
	"kubectl -n $NS port-forward svc/health-db $LOCAL_PORT:3306" &
TUNNEL_PID=$!

printf "    waiting for tunnel" >&2
for i in $(seq 1 60); do
	kill -0 "$TUNNEL_PID" 2>/dev/null || {
		echo " tunnel process exited" >&2
		exit 1
	}
	if (echo >"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
		echo " ok" >&2
		break
	fi
	printf . >&2
	sleep 0.5
	[ "$i" -eq 60 ] && {
		echo " timeout" >&2
		exit 1
	}
done

echo "==> running: $*" >&2
"$@"
