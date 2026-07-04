#!/usr/bin/env bash
# Deploy coach to isis. Run on the isis host (as root) after CI has published
# xinutec/coach:latest. Applies the manifests in numbered order and waits for
# the rollout.
#
# ONE-TIME prerequisites (not done here):
#   - a Nextcloud OAuth2 client "coach" (dash.xinutec.org admin → Settings →
#     Security → OAuth 2.0), redirect https://coach.xinutec.org/auth/callback.
#   - NC_CLIENT_ID=... NC_CLIENT_SECRET=... ./secret.sh  (creates coach-secret).
#   - the DNS CNAME coach → isis.xinutec.org (code/dns, tofu apply).
#   - the letsencrypt-prod ClusterIssuer on isis (already present, shared with
#     life/home/health — HTTP-01).
set -euo pipefail
cd "$(dirname "$0")"

kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-pvc.yaml
kubectl apply -f 02-db.yaml
kubectl apply -f 03-app.yaml
kubectl apply -f 04-ingress.yaml
# Only the safe DB-from-app policy. 06-networkpolicy-app-held.yaml is deliberately
# NOT applied (it would drop kubelet probes under k3s — see its header).
kubectl apply -f 05-networkpolicy.yaml

# Pick up a freshly-pushed :latest image even when the tag is unchanged.
kubectl -n coach rollout restart deploy/coach-app
kubectl -n coach rollout status deploy/coach-db --timeout=120s
kubectl -n coach rollout status deploy/coach-app --timeout=120s
