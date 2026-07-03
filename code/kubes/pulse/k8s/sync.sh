#!/usr/bin/env bash
# Deploy pulse to isis. Run on the isis host (as root) after CI has published
# xinutec/pulse:latest. Applies the manifests in numbered order and waits for
# the rollout.
#
# ONE-TIME prerequisites (not done here):
#   - the letsencrypt-dns ClusterIssuer + cloudflare-api-token secret on isis
#     (shared with messages — already present).
#   - ./secret.sh  (creates the pulse-secret with DB creds + ingest tokens).
#   - the DNS A record pulse → 10.100.0.2 (code/dns, tofu apply).
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
kubectl -n pulse rollout restart deploy/pulse-app
kubectl -n pulse rollout status deploy/pulse-db --timeout=120s
kubectl -n pulse rollout status deploy/pulse-app --timeout=120s
