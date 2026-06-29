#!/usr/bin/env bash
# Create `messages-secret` (session signing key + Nextcloud OAuth client) in the
# `signal` namespace. The DB creds come from the existing `signal-secret` in the
# same namespace — not duplicated here.
#
# Register the OAuth2 client first in Nextcloud admin (dash.xinutec.org →
# Settings → Security → OAuth 2.0) with redirect URI:
#   https://messages.xinutec.org/auth/callback
# then pass its id/secret in:
#   NC_CLIENT_ID=... NC_CLIENT_SECRET=... ./secret.sh
set -euo pipefail

: "${NC_CLIENT_ID:?set NC_CLIENT_ID (from the Nextcloud OAuth2 client)}"
: "${NC_CLIENT_SECRET:?set NC_CLIENT_SECRET (from the Nextcloud OAuth2 client)}"

SESSION_SECRET="$(openssl rand -hex 32)"

kubectl create secret -n signal generic messages-secret \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --from-literal=NC_CLIENT_ID="$NC_CLIENT_ID" \
  --from-literal=NC_CLIENT_SECRET="$NC_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "messages-secret created/updated in namespace signal."
