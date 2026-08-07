#!/usr/bin/env bash
# Run on isis (as root) to mint one of recall's device credentials into `recall-secret`.
#
#   secret.sh sync     # the Mac's bearer for /sync/* (push audio + transcripts, poll jobs)
#   secret.sh device   # the Android app's bearer for POST /api/sessions (uploads)
#
# The Mac is a one-way WireGuard peer — it dials the fleet, nothing dials back — so the
# sync token authenticates the Mac to Isis, not the other way round. Without it
# `recall.sync` registers no routes at all: Isis stays a plain LAN web UI and the
# migration is inert. That is deliberate (fail closed).
#
# The device token is the phone's, and only opens `POST /api/sessions`. It is separate
# from the sync token on purpose: a phone is easier to lose than a Mac, and the sync
# token opens the whole archive surface. Losing the phone costs uploads, not the archive.
#
# The printed token is shown ONCE. Rotating one stops that client working until the new
# value is copied across — the Mac's ~/.config/recall/sync-token (0600), or the app's
# Settings -> "upload token".
#
# PATCHES, never `create --dry-run | apply`. That form replaces the WHOLE secret, and
# `recall-secret` also carries SESSION_SECRET / NC_CLIENT_ID / NC_CLIENT_SECRET, added by
# hand when SSO went up. Every one of those is `optional: true` in the deployment, so
# wiping them does not crash the pod — it silently drops the Nextcloud sign-in wall and
# leaves recall open to anything on the VPN. Re-running this script used to do exactly
# that. A merge patch touches one key.
set -euo pipefail

case "${1:-}" in
  sync) key=SYNC_TOKEN; label="sync   (Mac: ~/.config/recall/sync-token, chmod 600)" ;;
  device) key=DEVICE_TOKEN; label="device (phone: Settings -> upload token)" ;;
  *)
    echo "usage: $0 sync|device" >&2
    exit 2
    ;;
esac

# /dev/urandom + base64 (coreutils) — openssl isn't on the NixOS host PATH. The `tr`
# drops the base64 characters that would need escaping in a URL or a shell.
token="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"

kubectl patch secret -n recall recall-secret \
  --type merge -p "{\"stringData\":{\"$key\":\"$token\"}}"

echo "== recall $label =="
echo "  $token"
echo "==============================================================================="
echo "The pod reads this at startup: kubectl rollout restart -n recall deploy/recall"
