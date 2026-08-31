#!/usr/bin/env bash
# Create `vaultwarden-secret` (the /admin panel token) in the `vaultwarden`
# namespace. Run once on isis (as root).
#
# ⚠ **RENAMED 2026-08-31 from `vaultwarden-admin`/`admin-token` to
# `vaultwarden-secret`/`ADMIN_TOKEN`**, because this tree is now generated from
# `dhall/apps/vaultwarden.dhall` and the model derives the secret's name from the
# namespace. The rename is the model's, not a decision taken here.
#
# ⚠ **MIGRATING? PASS THE EXISTING TOKEN.** Re-running without `VW_ADMIN_TOKEN`
# mints a NEW one, which is safe for the vault's data but silently invalidates
# the token you have saved. To carry the live one across:
#
#   VW_ADMIN_TOKEN=$(kubectl -n vaultwarden get secret vaultwarden-admin \
#     -o jsonpath='{.data.admin-token}' | base64 -d) ./secret.sh
#
# The ADMIN_TOKEN only gates Vaultwarden's /admin diagnostics page — it is NOT
# the vault's encryption key (that is pippijn's master password, never on the
# server). So regenerating it loses nothing but the saved token.
set -euo pipefail

# /dev/urandom + base64 (coreutils) — openssl isn't on the NixOS host PATH.
ADMIN_TOKEN="${VW_ADMIN_TOKEN:-$(head -c 32 /dev/urandom | base64 | tr -d '/+=')}"

echo "== vaultwarden admin token (login at https://vault.xinutec.org/admin) =="
echo "  $ADMIN_TOKEN"
echo "========================================================================"

kubectl create secret -n vaultwarden generic vaultwarden-secret \
  --from-literal=ADMIN_TOKEN="$ADMIN_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "vaultwarden-secret created/updated in namespace vaultwarden."
echo
echo "⚠ The OLD secret vaultwarden-admin is left in place deliberately: it is the"
echo "  rollback for the hand-written manifests. Delete it only after the modelled"
echo "  Deployment is confirmed healthy."
