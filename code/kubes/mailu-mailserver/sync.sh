#!/usr/bin/env bash

set -euo pipefail

# Chart-created storage (invisible to any manifest scan — declared here so the
# backup-coverage model is complete; see dev-lint DL-DEPLOY-BACKUP-COVERAGE):
# dev-lint: pvc mailu-mailserver/mailu-storage
# dev-lint: pvc mailu-mailserver/redis-data-mailu-redis-master-0
# dev-lint: pvc mailu-mailserver/data-mailu-clamav-0 allow-backup-coverage clamav signature DB, re-downloaded on start
# Chart-version BUMP gotchas (learned upgrading 2.1.1 -> 2.7.3, 2026-07-22). None of
# these apply to a same-version re-run; they bite only when --version changes:
#   1. StatefulSet immutable fields: the chart changed a forbidden field on
#      mailu-clamav, so `helm upgrade` errors "updates to statefulset spec ... are
#      forbidden". Delete the SS first (pod stays; clamav is regenerable):
#        kubectl -n mailu-mailserver delete statefulset mailu-clamav --cascade=orphan
#      then re-run this script. (The release ends 'failed' until the re-run succeeds.)
#   2. front hostPort: front binds the mail ports via hostPort on the single node, so
#      a RollingUpdate deadlocks (new pod Pending "no free ports", old never leaves).
#      Delete the OLD front pod to hand the ports over (a few seconds' front downtime).
#   3. mailu-roundcube secret: see the FOOTGUN note in values.yaml — recreate it
#      standalone if a prior upgrade pruned it.
sudo helm upgrade --install mailu mailu/mailu --version 2.7.3 -n mailu-mailserver --create-namespace --values values.yaml --values secrets.yaml

# Workaround: chart 2.1.1's clamav probes check /tmp/clamd.pid which
# the official clamav-debian image doesn't create, and uses pgrep which
# isn't installed. Use clamdscan --ping (ClamAV's built-in health check).
# 300s initial delay gives time for signature download + load on first start.
sudo kubectl -n mailu-mailserver patch statefulset mailu-clamav --type=json -p='[
  {"op": "replace", "path": "/spec/template/spec/containers/0/readinessProbe/exec/command", "value": ["clamdscan", "--ping", "30"]},
  {"op": "replace", "path": "/spec/template/spec/containers/0/livenessProbe/exec/command", "value": ["clamdscan", "--ping", "30"]},
  {"op": "replace", "path": "/spec/template/spec/containers/0/livenessProbe/initialDelaySeconds", "value": 300}
]'
