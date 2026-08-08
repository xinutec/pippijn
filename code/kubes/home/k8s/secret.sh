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
  # Assigned before the command, not substituted inside its arguments — the
  # second half of the lesson in this file's header. Moving off openssl stopped
  # the generator failing; it did not stop a failing generator being INVISIBLE,
  # because a substitution in an argument has its status discarded and `set -e`
  # never sees it. The all-empty secret got here by both together.
  DB_PASSWORD="$(rnd 16)"
  DB_ROOT_PASSWORD="$(rnd 16)"
  INGEST_TOKEN="$(rnd 24)"
  SESSION_SECRET="$(rnd 32)"
  kubectl -n home create secret generic home-secret \
    --from-literal=DB_USER=home \
    --from-literal="DB_PASSWORD=$DB_PASSWORD" \
    --from-literal="DB_ROOT_PASSWORD=$DB_ROOT_PASSWORD" \
    --from-literal="INGEST_TOKEN=$INGEST_TOKEN" \
    --from-literal="SESSION_SECRET=$SESSION_SECRET"
  echo "home-secret created."
else
  echo "home-secret already exists — leaving it untouched."
fi

# The Nextcloud OAuth client is registered by hand (Settings -> Security ->
# OAuth 2.0 clients, redirect https://home.xinutec.org/auth/callback) and its
# id/secret pasted in here — they cannot be generated. Left out of the create
# above so a re-run never clobbers a working pair.
if [ -n "${NC_CLIENT_ID:-}" ] && [ -n "${NC_CLIENT_SECRET:-}" ]; then
  kubectl -n home patch secret home-secret --type=merge \
    -p "{\"stringData\":{\"NC_CLIENT_ID\":\"$NC_CLIENT_ID\",\"NC_CLIENT_SECRET\":\"$NC_CLIENT_SECRET\"}}"
  echo "Nextcloud OAuth client stored."
fi

echo "INGEST_TOKEN (give this to the Mac poller's Keychain):"
kubectl -n home get secret home-secret -o jsonpath='{.data.INGEST_TOKEN}' | base64 -d
echo
