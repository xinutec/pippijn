#!/usr/bin/env bash
# Run once on isis (as root) to create the pulse k8s secret. Generates the DB
# credentials and one ingest token per producer.
#
#   ./secret.sh                    # default: a single 'mac-mini' producer token
#   PULSE_SOURCES="mac-mini odin" ./secret.sh   # a token per named producer
#
# The printed producer tokens are shown ONCE — copy each to its producer's
# ~/.config/pulse/token (0600) so the pusher can authenticate. Re-running
# rotates every secret (and invalidates old tokens).
set -euo pipefail

SOURCES="${PULSE_SOURCES:-mac-mini}"

# /dev/urandom + base64 (coreutils) — openssl isn't on the NixOS host PATH.
# Strip URL-significant chars from the DB password so the DSN needs no escaping.
DB_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
DB_ROOT_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"

# One token per producer source; assemble the source:token pairs for PULSE_TOKENS.
PAIRS=""
echo "== producer ingest tokens (copy each to its producer's ~/.config/pulse/token) =="
for src in $SOURCES; do
  tok="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  echo "  $src : $tok"
  PAIRS="${PAIRS:+$PAIRS,}${src}:${tok}"
done
echo "==============================================================================="

kubectl create secret -n pulse generic pulse-secret \
  --from-literal=DB_USER=pulse \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  --from-literal=DB_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
  --from-literal=DATABASE_URL="mysql://pulse:${DB_PASSWORD}@pulse-db/pulse" \
  --from-literal=PULSE_TOKENS="$PAIRS" \
  --dry-run=client -o yaml | kubectl apply -f -
