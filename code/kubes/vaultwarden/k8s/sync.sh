#!/usr/bin/env bash
# Deploy vaultwarden to isis. Run on the isis host (as root). Applies the
# manifests in numbered order and waits for the rollout. Idempotent — safe to
# re-run to pick up manifest changes.
#
# Migrated off Flux (was fleet/apps/amun/vaultwarden) — isis has no Flux; this
# matches the sync.sh convention the rest of the fleet uses (messages/fleetwatch).
#
# ONE-TIME prerequisites (not done here):
#   - the letsencrypt-dns ClusterIssuer + cloudflare-api-token secret on isis
#     (shared with messages/fleetwatch — already present).
#   - ./secret.sh  (creates vaultwarden-admin with the /admin token).
#   - the vault data migrated into the PVC (see README.md — the one-time,
#     watched copy of the 5.6 MB sqlite DB from amun; this is the password vault).
#   - the DNS A record vault -> 10.100.0.2 (code/dns, tofu apply) — cut over
#     LAST, only after the data is in place and the isis instance is verified.
set -euo pipefail
cd "$(dirname "$0")"

kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-pvc.yaml
kubectl apply -f 02-app.yaml
kubectl apply -f 03-ingress.yaml

# Recreate strategy + single RWO PVC: a restart tears the old pod down first.
kubectl -n vaultwarden rollout restart deploy/vaultwarden
kubectl -n vaultwarden rollout status deploy/vaultwarden --timeout=120s
