#!/usr/bin/env bash

set -euo pipefail

# Chart-created storage (invisible to any manifest scan — declared here so the
# backup-coverage model is complete; see dev-lint DL-DEPLOY-BACKUP-COVERAGE):
# dev-lint: pvc mailu-mailserver/mailu-storage
# dev-lint: pvc mailu-mailserver/data-mailu-clamav-0 allow-backup-coverage clamav signature DB, re-downloaded on start
# (redis is no longer a chart PVC: bundled Bitnami redis was replaced by our own
# mailu-redis-ext-data PVC in redis-ext.yaml — backed up via odin backup-prepare.sh.)
# Chart-version BUMP gotchas (learned upgrading 2.1.1 -> 2.7.3, 2026-07-22). None of
# these apply to a same-version re-run; they bite only when --version changes:
#   1. StatefulSet immutable fields: the chart changed a forbidden field on
#      mailu-clamav, so `helm upgrade` errors "updates to statefulset spec ... are
#      forbidden". Delete the SS first (pod stays; clamav is regenerable):
#        kubectl -n mailu-mailserver delete statefulset mailu-clamav --cascade=orphan
#      then re-run this script. (The release ends 'failed' until the re-run succeeds.)
#   3. mailu-roundcube secret: see the FOOTGUN note in values.yaml — recreate it
#      standalone if a prior upgrade pruned it.
#
# ANY-image-roll gotchas — these bite whenever front/postfix are rolled to a new
# image, including a `mailuVersion` bump (values.yaml), NOT just --version changes.
# Both are shared-single-resource RollingUpdate deadlocks; fix each with scale 0->1:
#   2. front hostPort: front binds the mail ports via hostPort on the single node, so
#      the new pod stays Pending "no free ports" and the old never leaves. Recover:
#        kubectl -n mailu-mailserver scale deploy/mailu-front --replicas=0   # wait for pods gone
#        kubectl -n mailu-mailserver scale deploy/mailu-front --replicas=1
#      (a few seconds' front downtime — all public mail+web ports). Deleting just the
#      old pod is NOT enough: the old ReplicaSet respawns it and both Pend, racing.
#   4. postfix spool lock: postfix and its replacement both mount the RWO spool PVC on
#      the one node, so the new pod CrashLoopBackOffs with "the Postfix mail system is
#      already running" (old holds master.pid). Same fix: scale mailu-postfix 0 -> 1.
# NB: this deployment exposes only implicit-TLS client ports (465/993/995) + 25/443;
# the plaintext-STARTTLS ports 587/143/110 are intentionally NOT served (by design,
# not a regression) — clients use 465/993.
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
