#!/usr/bin/env bash
# Run once on isis (as root) to create recall's k8s secret: the sync token the Mac
# presents as a bearer to push audio + transcripts and to poll for jobs.
#
# The Mac is a one-way WireGuard peer — it dials the fleet, nothing dials back — so this
# token is the *only* credential in the split, and it authenticates the Mac to Isis, not
# the other way round. Without it `recall.sync` registers no routes at all: Isis stays a
# plain LAN web UI and the migration is inert. That is deliberate (fail closed).
#
# The printed token is shown ONCE. Copy it to the Mac's ~/.config/recall/sync-token
# (0600). Re-running rotates it, which will stop the Mac pushing until the new value is
# copied across.
set -euo pipefail

# /dev/urandom + base64 (coreutils) — openssl isn't on the NixOS host PATH.
SYNC_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"

echo "== recall sync token (copy to the Mac: ~/.config/recall/sync-token, chmod 600) =="
echo "  sync : $SYNC_TOKEN"
echo "================================================================================"

kubectl create secret -n recall generic recall-secret \
  --from-literal=SYNC_TOKEN="$SYNC_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
