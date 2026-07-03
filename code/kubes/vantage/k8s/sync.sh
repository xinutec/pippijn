#!/usr/bin/env bash
# Deploy vantage to isis. Run on the isis host (as root) after CI has published
# xinutec/vantage:latest. Applies the manifests in numbered order and waits for
# the rollout.
#
# ONE-TIME prerequisites (not done here):
#   - the letsencrypt-dns ClusterIssuer + cloudflare-api-token secret on isis
#     (shared with messages — already present).
#   - ./secret.sh  (creates the vantage-secret with DB creds + ingest tokens).
#   - the DNS A record vantage → 10.100.0.2 (code/dns, tofu apply).
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
kubectl -n vantage rollout restart deploy/vantage-app
kubectl -n vantage rollout status deploy/vantage-db --timeout=120s
kubectl -n vantage rollout status deploy/vantage-app --timeout=120s
