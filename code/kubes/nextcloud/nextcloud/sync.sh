#!/bin/sh

set -euo pipefail

sudo helm upgrade --install redis bitnami/redis -n nextcloud --create-namespace --values helm/redis-values.yaml
