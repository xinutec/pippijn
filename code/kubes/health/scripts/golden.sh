#!/usr/bin/env nix-shell
#!nix-shell -i bash -p openssh nodejs_22
# Run the golden-day regression check against prod data — one command.
#
# Builds the project locally, opens a tunnel to the prod health-db,
# runs golden-check.js with your *local* pipeline code, and tears the
# tunnel down again. Because it runs the locally-built code, it sees
# whatever pipeline changes you have made — that is the point: catch
# regressions before they ship.
#
# Usage:
#   scripts/golden.sh                  # check every day in the manifest
#   scripts/golden.sh --bless          # re-bless every day
#   scripts/golden.sh --bless 2026-05-15   # re-bless one day
#
# Via npm (note the `--` so npm forwards the flags):
#   npm run golden
#   npm run golden -- --bless 2026-05-15
#
# Exit 0 = every day matches its baseline. Exit 1 = a day regressed.
#
# The shebang pulls ssh / node via nix-shell so this runs directly on
# macOS. Same pattern as scripts/deploy.sh.

set -euo pipefail

HEALTH_HOST=root@isis.xinutec.org
NS=health
LOCAL_PORT=13306

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> [1/4] building"
npm run build >/dev/null

echo "==> [2/4] fetching DB credentials from prod"
POD=$(ssh "$HEALTH_HOST" \
	"kubectl -n $NS get pods -l app=health-auth -o jsonpath='{.items[0].metadata.name}'")
[ -n "$POD" ] || { echo "could not find a health-auth pod" >&2; exit 1; }
# One round-trip: dump the pod env, pick out the vars we need locally.
# Captured into a shell var — never echoed.
ENVDUMP=$(ssh "$HEALTH_HOST" "kubectl -n $NS exec $POD -- printenv")
get() { printf '%s\n' "$ENVDUMP" | grep "^$1=" | head -1 | cut -d= -f2- || true; }
DB_USER=$(get DB_USER)
DB_PASSWORD=$(get DB_PASSWORD)
DB_NAME=$(get DB_NAME)
NC_BASE_URL=$(get NC_BASE_URL)
NC_CLIENT_ID=$(get NC_CLIENT_ID)
NC_CLIENT_SECRET=$(get NC_CLIENT_SECRET)
[ -n "$DB_PASSWORD" ] || { echo "DB_PASSWORD not found in pod env" >&2; exit 1; }
export DB_USER DB_PASSWORD DB_NAME NC_CLIENT_ID NC_CLIENT_SECRET
export DB_HOST=127.0.0.1 DB_PORT="$LOCAL_PORT"
# Pin the host timezone. The pipeline is not fully tz-pure, so its
# output depends on the host TZ; prod runs in UTC, so the golden
# baselines are UTC-host output and the check must reproduce that.
export TZ=UTC
# NC_BASE_URL is unset in the pod (the app falls back to a built-in
# default). Only export it when prod actually sets it — exporting an
# empty string would defeat the default and fail URL validation.
[ -n "$NC_BASE_URL" ] && export NC_BASE_URL || true

echo "==> [3/4] opening tunnel to prod health-db"
# The `[k]ubectl` bracket keeps this pattern from matching its own
# pkill command line (whose args would otherwise contain the literal
# string), so cleanup only ever kills real kubectl port-forwards.
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

printf "    waiting for tunnel"
for i in $(seq 1 60); do
	kill -0 "$TUNNEL_PID" 2>/dev/null || { echo " tunnel process exited"; exit 1; }
	if (echo >"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
		echo " ok"
		break
	fi
	printf .
	sleep 0.5
	[ "$i" -eq 60 ] && { echo " timeout"; exit 1; }
done

echo "==> [4/4] running golden-check"
node dist/cli/golden-check.js "$@"
