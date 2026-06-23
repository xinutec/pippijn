#!/usr/bin/env bash
# One-time (idempotent) creation of `home-secret` in the `home` namespace.
# Run on isis: `ssh root@isis.xinutec.org 'bash -s' < k8s/secret.sh`
#
# Generates random DB passwords and an INGEST_TOKEN as hex from /dev/urandom —
# NOT openssl, which isn't on isis's PATH (an earlier openssl-based version
# silently produced an all-empty secret). The INGEST_TOKEN must be given to the
# Mac poller (stored in its Keychain) so it can POST /api/ingest.
set -euo pipefail

# N random bytes as hex. head + od + tr are always present; openssl may not be.
rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

kubectl create namespace home --dry-run=client -o yaml | kubectl apply -f -

# Only create the secret if it doesn't exist, so re-runs don't rotate the
# passwords out from under a running DB.
if ! kubectl -n home get secret home-secret >/dev/null 2>&1; then
  kubectl -n home create secret generic home-secret \
    --from-literal=DB_USER=home \
    --from-literal="DB_PASSWORD=$(rnd 16)" \
    --from-literal="DB_ROOT_PASSWORD=$(rnd 16)" \
    --from-literal="INGEST_TOKEN=$(rnd 24)"
  echo "home-secret created."
else
  echo "home-secret already exists — leaving it untouched."
fi

echo "INGEST_TOKEN (give this to the Mac poller's Keychain):"
kubectl -n home get secret home-secret -o jsonpath='{.data.INGEST_TOKEN}' | base64 -d
echo
