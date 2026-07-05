#!/usr/bin/env bash
set -euo pipefail

sudo helm upgrade --install metallb metallb/metallb -n metallb --create-namespace --values values.yaml
