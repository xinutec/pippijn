#!/usr/bin/env bash
# One-time (idempotent) creation of `home-secret` in the `home` namespace.
# Run on isis: `ssh root@isis.xinutec.org 'bash -s' < secret.sh`
#
# Generates random DB passwords and an INGEST_TOKEN. The INGEST_TOKEN must be
# given to the Mac poller (stored in its Keychain) so it can POST /api/ingest.
set -euo pipefail

kubectl create namespace home --dry-run=client -o yaml | kubectl apply -f -

# --dry-run|apply makes this idempotent without clobbering existing values:
# only create the secret if it doesn't exist yet.
if ! kubectl -n home get secret home-secret >/dev/null 2>&1; then
  kubectl -n home create secret generic home-secret \
    --from-literal=DB_USER=home \
    --from-literal=DB_PASSWORD="$(openssl rand -base64 24)" \
    --from-literal=DB_ROOT_PASSWORD="$(openssl rand -base64 24)" \
    --from-literal=INGEST_TOKEN="$(openssl rand -hex 24)"
  echo "home-secret created."
else
  echo "home-secret already exists — leaving it untouched."
fi

echo "INGEST_TOKEN (give this to the Mac poller's Keychain):"
kubectl -n home get secret home-secret -o jsonpath='{.data.INGEST_TOKEN}' | base64 -d
echo
