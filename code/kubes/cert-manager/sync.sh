#!/usr/bin/env bash
set -euo pipefail

sudo helm upgrade --install \
  cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.16.2 \
  --set crds.enabled=true \
  --set prometheus.enabled=false
sudo kubectl apply -f .
