#!/usr/bin/env bash

set -euo pipefail

# Chart-created storage (declared for the backup-coverage model; the live RDB
# dump in backup-prepare.sh covers the data, not an rsync of this PVC):
# dev-lint: pvc nextcloud/redis-data-redis-master-0
sudo helm upgrade --install redis bitnami/redis -n nextcloud --create-namespace --values helm/redis-values.yaml
