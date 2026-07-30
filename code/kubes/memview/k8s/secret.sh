#!/usr/bin/env bash
# Run on isis (as root) to create or replace the memview k8s secret.
#
#   ./secret.sh
#
# Prompts for the Nextcloud OAuth2 client values and generates the session
# secret itself. Get the client from Nextcloud admin → Settings → Security →
# OAuth 2.0: client "memview", redirect
# https://memview.xinutec.org/auth/callback.
#
# **Prompted, not passed in.** The obvious shape — `NC_CLIENT_ID=... ./secret.sh`
# — writes the client secret into your shell history, into the process table
# while it runs, and into wherever the command was composed. Reading it here
# means the value goes from the keyboard to kubectl and lands nowhere else,
# which is what makes rotating the client cheap rather than a thing to put off.
#
# Safe to re-run: the session secret is regenerated, which signs you out and
# costs one sign-in. Nothing else is derived from it — there is no database in
# this app — so unlike life's script there is nothing to destroy by running it
# twice. The share token lives in a file on the volume and is untouched.
set -euo pipefail

read -rp  'Nextcloud client id: '     NC_CLIENT_ID
read -rsp 'Nextcloud client secret: ' NC_CLIENT_SECRET
echo

[ -n "$NC_CLIENT_ID" ]     || { echo "no client id given" >&2; exit 2; }
[ -n "$NC_CLIENT_SECRET" ] || { echo "no client secret given" >&2; exit 2; }

# /dev/urandom + base64 (coreutils) — openssl is not on the NixOS host's
# non-interactive root PATH.
SESSION_SECRET="$(head -c 36 /dev/urandom | base64 | tr -d '\n')"

kubectl create secret -n memview generic memview-secret \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --from-literal=NC_CLIENT_ID="$NC_CLIENT_ID" \
  --from-literal=NC_CLIENT_SECRET="$NC_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

# All three keys are required rather than optional secretKeyRefs: the app's
# sign-in gate is the only thing between the corpus — medical context, family,
# addresses — and anyone who reaches the ingress. A pod that refuses to start is
# the safe failure; a pod that starts unguarded is not.
echo "memview-secret written. Roll the deployment to pick it up:"
echo "  kubectl -n memview rollout restart deploy/memview"
