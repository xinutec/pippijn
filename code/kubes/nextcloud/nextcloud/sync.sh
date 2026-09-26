#!/usr/bin/env bash

set -euo pipefail

# Chart-created storage (declared for the backup-coverage model; the nightly
# `nextcloud-redis` artifact's RDB dump covers the data, not an rsync of this
# PVC — a live RDB file copies torn mid-write, so the volume is deliberately
# never mirrored):
# dev-lint: pvc nextcloud/redis-data-redis-master-0 allow-backup-coverage the RDB stream is the snapshot; the volume underneath it is never mirrored
# Chart-created workload the odin backup execs into (redis RDB dump).
# dev-lint: workload nextcloud/statefulset/redis-master
# Pinned: an unpinned upgrade would move redis to whatever the repo index says.
sudo helm upgrade --install redis bitnami/redis --version 22.0.7 -n nextcloud --create-namespace --values helm/redis-values.yaml
