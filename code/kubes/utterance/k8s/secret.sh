#!/usr/bin/env bash
# Run on isis (as root) to create or replace the utterance k8s secret.
#
#   ./secret.sh
#
# Prompts for the Nextcloud OAuth2 client values and generates the session
# secret itself. Get the client from Nextcloud admin → Settings → Security →
# OAuth 2.0: client "utterance", redirect
# https://utterance.xinutec.org/auth/callback.
#
# **Prompted, not passed in.** The obvious shape — `NC_CLIENT_ID=... ./secret.sh`
# — writes the client secret into your shell history, into the process table
# while it runs, and into wherever the command was composed. Reading it here
# means the value goes from the keyboard to kubectl and lands nowhere else,
# which is what makes rotating the client cheap rather than a thing to put off.
#
# Safe to re-run: the session secret is regenerated, which signs everyone out
# and costs one sign-in. Nothing else is derived from it, so unlike life's
# script there is no database password to destroy by running this twice.
set -euo pipefail

read -rp  'Nextcloud client id: '     NC_CLIENT_ID
read -rsp 'Nextcloud client secret: ' NC_CLIENT_SECRET
echo

[ -n "$NC_CLIENT_ID" ]     || { echo "no client id given" >&2; exit 2; }
[ -n "$NC_CLIENT_SECRET" ] || { echo "no client secret given" >&2; exit 2; }

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
