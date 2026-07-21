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

# Emotion suggestions need no secret: EMOTION_MODEL_URL (a self-hosted model
# server) is a plain env var in 03-app.yaml, not a credential.
