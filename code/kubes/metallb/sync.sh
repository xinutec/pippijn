#!/usr/bin/env bash
set -euo pipefail

# dev-lint: pvc none
sudo helm upgrade --install metallb metallb/metallb -n metallb --create-namespace --values values.yaml
