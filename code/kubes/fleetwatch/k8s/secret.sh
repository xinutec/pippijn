#!/usr/bin/env bash
# Run once on isis (as root) to create the fleetwatch k8s secret. Generates the DB
# credentials and one ingest token per producer.
#
#   ./secret.sh                    # default: a single 'mac-mini' producer token
#   FLEETWATCH_SOURCES="mac-mini odin" ./secret.sh   # a token per named producer
#
# ⚠ THE LIVE SOURCES ARE mac-mini, amun, isis, odin, shu AND geb — read from the
# live secret 2026-09-04, not from memory. isis was added 2026-08-11 when the
# picade fleet moved there from amun; shu and geb on 2026-09-04, when the one-way
# firewall block moved onto the home machines and the plan that checks it had to
# follow. This list had drifted three sources behind, which matters BECAUSE of
# the sentence below: re-running with a stale list silently DEAUTHORISES every
# producer it omits. This script REGENERATES EVERYTHING — DB
# passwords, the read token the Android app holds, the session secret — so it is
# the wrong tool for adding one producer. To add a source without rotating the
# rest, append a `source:token` pair to the live secret's FLEETWATCH_TOKENS and
# restart the app. Named here so the list is not lost if this ever is re-run.
#
# The printed producer tokens are shown ONCE — copy each to its producer's
# ~/.config/fleetwatch/token (0600) so the pusher can authenticate. Re-running
# rotates every secret (and invalidates old tokens).
set -euo pipefail

SOURCES="${FLEETWATCH_SOURCES:-mac-mini}"

# /dev/urandom + base64 (coreutils) — openssl isn't on the NixOS host PATH.
# Strip URL-significant chars from the DB password so the DSN needs no escaping.
DB_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
DB_ROOT_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
# HMAC key for the human login-session cookies (see src/session.rs).
SESSION_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"

# The READ token: opens GET /api/problems and nothing else (see src/auth.rs). It exists
# for the Android app's background poller, which asks "is anything wrong?" every 30 min
# and can't complete an interactive Nextcloud login from a WorkManager job. Read-only and
# single-endpoint, so a lost phone leaks neither write access nor the report history.
READ_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"

# Nextcloud OAuth2 client (the human login gate) — created by hand in
# dash.xinutec.org → Admin → Security → OAuth 2.0 clients, redirect URI
# https://fleetwatch.xinutec.org/auth/callback. Supplied via the environment,
# not generated (rotating it means re-registering in Nextcloud):
#   NC_CLIENT_ID=… NC_CLIENT_SECRET=… ./secret.sh
: "${NC_CLIENT_ID:?set NC_CLIENT_ID (Nextcloud OAuth2 client identifier)}"
: "${NC_CLIENT_SECRET:?set NC_CLIENT_SECRET (Nextcloud OAuth2 client secret)}"

# One token per producer source; assemble the source:token pairs for FLEETWATCH_TOKENS.
PAIRS=""
echo "== producer ingest tokens (copy each to its producer's ~/.config/fleetwatch/token) =="
for src in $SOURCES; do
  tok="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  echo "  $src : $tok"
  PAIRS="${PAIRS:+$PAIRS,}${src}:${tok}"
done
echo "==============================================================================="
echo "== read token (Mac Keychain: security add-generic-password -a fleetwatch \\"
echo "==   -s fleetwatch-read-token -w '<token>' -U   — then android/deploy.sh injects it) =="
echo "  read : $READ_TOKEN"
echo "==============================================================================="

kubectl create secret -n fleetwatch generic fleetwatch-secret \
  --from-literal=FLEETWATCH_READ_TOKENS="$READ_TOKEN" \
  --from-literal=DB_USER=fleetwatch \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  --from-literal=DB_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
  --from-literal=DATABASE_URL="mysql://fleetwatch:${DB_PASSWORD}@fleetwatch-db/fleetwatch" \
  --from-literal=FLEETWATCH_TOKENS="$PAIRS" \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --from-literal=NC_CLIENT_ID="$NC_CLIENT_ID" \
  --from-literal=NC_CLIENT_SECRET="$NC_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -
