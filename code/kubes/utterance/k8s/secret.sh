#!/usr/bin/env bash
# Run once on isis (as root) to create the utterance k8s secret. Generates the
# session secret; the Nextcloud OAuth2 client values are passed in:
#
#   NC_CLIENT_ID=... NC_CLIENT_SECRET=... ./secret.sh
#
# (From Nextcloud admin → Settings → Security → OAuth 2.0, client "utterance",
#  redirect https://utterance.xinutec.org/auth/callback.)
#
# Safe to re-run: the session secret is regenerated, which signs everyone out
# and costs one sign-in. Nothing else is derived from it, so unlike life's
# script there is no database password to destroy by running this twice.
set -euo pipefail

: "${NC_CLIENT_ID:?set NC_CLIENT_ID}"
: "${NC_CLIENT_SECRET:?set NC_CLIENT_SECRET}"

# /dev/urandom + base64 (coreutils) — openssl is not on the NixOS host's
# non-interactive root PATH.
UTTERANCE_SESSION_SECRET="$(head -c 36 /dev/urandom | base64 | tr -d '\n')"

kubectl create secret -n utterance generic utterance-secret \
  --from-literal=UTTERANCE_SESSION_SECRET="$UTTERANCE_SESSION_SECRET" \
  --from-literal=NC_CLIENT_ID="$NC_CLIENT_ID" \
  --from-literal=NC_CLIENT_SECRET="$NC_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

# All three keys are required rather than optional: the app's sign-in gate stays
# DOWN unless every one of them is set, and a pod that starts without them
# serves recordings of two people's voices to anybody who finds the hostname.
echo "utterance-secret written. Roll the pod to pick it up:"
echo "  kubectl -n utterance rollout restart deploy/utterance"
