#!/usr/bin/env bash
# Create `vaultwarden-admin` (the /admin panel token) in the `vaultwarden`
# namespace. Run once on isis (as root).
#
# Replaces the old SOPS-encrypted admin-token.enc.yaml from the Flux setup:
# the token is generated here and printed ONCE, not committed encrypted.
#
# The ADMIN_TOKEN only gates Vaultwarden's /admin diagnostics page — it is NOT
# the vault's encryption key (that is pippijn's master password, never on the
# server). So regenerating it here is safe and loses nothing; to keep an
# existing token instead, pass it in:  VW_ADMIN_TOKEN=<token> ./secret.sh
set -euo pipefail

# /dev/urandom + base64 (coreutils) — openssl isn't on the NixOS host PATH.
ADMIN_TOKEN="${VW_ADMIN_TOKEN:-$(head -c 32 /dev/urandom | base64 | tr -d '/+=')}"

echo "== vaultwarden admin token (login at https://vault.xinutec.org/admin) =="
echo "  $ADMIN_TOKEN"
echo "========================================================================"

kubectl create secret -n vaultwarden generic vaultwarden-admin \
  --from-literal=admin-token="$ADMIN_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "vaultwarden-admin created/updated in namespace vaultwarden."
