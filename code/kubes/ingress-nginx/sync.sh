#!/usr/bin/env bash
set -euo pipefail

# dev-lint: pvc none
sudo helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx --namespace ingress-nginx --create-namespace -f values.yaml
