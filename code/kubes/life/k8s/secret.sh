#!/usr/bin/env bash
# Run once on isis (as root) to create the life k8s secret. Generates the DB
# and session secrets; the Nextcloud OAuth2 client values are passed in:
#
#   NC_CLIENT_ID=... NC_CLIENT_SECRET=... ./secret.sh
#
# (From Nextcloud admin → Settings → Security → OAuth 2.0, client "life",
#  redirect https://life.xinutec.org/auth/callback.)
set -euo pipefail

: "${NC_CLIENT_ID:?set NC_CLIENT_ID}"
: "${NC_CLIENT_SECRET:?set NC_CLIENT_SECRET}"

# /dev/urandom + base64 (coreutils) — openssl isn't on the NixOS host PATH.
# Strip URL-significant chars from the DB password so the DSN needs no escaping.
DB_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
DB_ROOT_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
SESSION_SECRET="$(head -c 36 /dev/urandom | base64 | tr -d '\n')"

kubectl create secret -n life generic life-secret \
  --from-literal=DB_USER=life \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  --from-literal=DB_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
  --from-literal=DATABASE_URL="mysql://life:${DB_PASSWORD}@life-db/life" \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --from-literal=NC_CLIENT_ID="$NC_CLIENT_ID" \
  --from-literal=NC_CLIENT_SECRET="$NC_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

# ANTHROPIC_API_KEY (optional; powers /api/wellbeing/suggest-emotions) is NOT set
# here — this script regenerates the DB/session secrets on every run, so it must
# not be re-run just to add a key. Merge it in-place instead, without disturbing
# the other values:
#
#   kubectl patch secret life-secret -n life --type merge \
#     -p '{"stringData":{"ANTHROPIC_API_KEY":"sk-ant-..."}}'
#   kubectl rollout restart deploy/life-app -n life
#
# The Deployment reads it via an `optional: true` secretKeyRef (03-app.yaml), so
# the app runs with or without it; absent → the picker just skips suggestions.
