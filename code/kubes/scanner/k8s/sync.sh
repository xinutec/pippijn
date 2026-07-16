#!/usr/bin/env bash
# Deploy the scanner preview server to isis. Run on the isis host (as root)
# after scanner's server/deploy/deploy-isis.sh has imported the image into
# containerd (there is no registry — the scanner repo is local-only, so the
# image is nix-built on isis and hand-imported; imagePullPolicy is Never).
#
# Deliberately NO Ingress and NO DNS record. The server is reachable only on
# isis's WireGuard address (10.100.0.2:8090) via a hostPort pinned to that IP —
# see 02-deployment.yaml. Scans are private documents; the shared nginx ingress
# answers on isis's *public* IP whatever DNS says, so it must never front this.
set -euo pipefail
cd "$(dirname "$0")"

kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-pvc.yaml
kubectl apply -f 02-deployment.yaml
kubectl apply -f 03-service.yaml
kubectl apply -f 04-networkpolicy.yaml

# Pick up a freshly-imported :local even when the tag is unchanged.
kubectl -n scanner rollout restart deploy/scanner
kubectl -n scanner rollout status deploy/scanner --timeout=180s
