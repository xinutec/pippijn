#!/usr/bin/env bash
# Mailu's own manifests on amun, through the deploy plan (../../deploy.sh): the
# external redis and the roundcube Secret, both kept out of the chart on purpose.
#
# The chart is not installed here. Its version, values files and arguments are a
# row in xinutec-infra's plan/tables/helm.dhall, applied from the Mac with
# `plan-run helm --settings plan/settings.json --apply`, which first checks that
# the release Helm has on record is what that row renders.
#
# It runs as the chart ships. The chart's clamav probes hand a shell pipe to
# `echo` and always pass; a sync.sh used to patch in `clamdscan --ping` after
# every install. Since 2026-10-03 the helm plan asks clamd itself (`ClamdAnswers`)
# and reports when it does not answer.
#
# The cluster comes from ../../dhall/placed.dhall, since no model places this tree.
set -euo pipefail

# Chart-created storage (invisible to any manifest scan — declared here so the
# backup-coverage model is complete; see dev-lint DL-DEPLOY-BACKUP-COVERAGE):
# dev-lint: pvc mailu-mailserver/mailu-storage
# dev-lint: pvc mailu-mailserver/data-mailu-clamav-0 allow-backup-coverage clamav signature DB, re-downloaded on start
# Chart-created workload the odin backup execs into (mailu-admin dumps roundcube).
# dev-lint: workload mailu-mailserver/deploy/mailu-admin
# (redis is not a chart PVC: ours is mailu-redis-ext-data in redis-ext.yaml,
# backed up by odin.)
# Chart-version BUMP gotchas, for `plan-run helm --apply` after a version change
# in helm.dhall. None of these apply to a same-version re-run:
#   1. StatefulSet immutable fields: the chart changed a forbidden field on
#      mailu-clamav, so `helm upgrade` errors "updates to statefulset spec ... are
#      forbidden". Delete the SS first (pod stays; clamav is regenerable):
#        kubectl -n mailu-mailserver delete statefulset mailu-clamav --cascade=orphan
#      then apply the plan again. (The release ends 'failed' until that succeeds.)
#   3. mailu-roundcube secret: see the FOOTGUN note in ../values.yaml. If an upgrade
#      prunes it, the deploy plan sees roundcube-secret.yaml missing and re-applies it.
#
# ANY-image-roll gotchas — these bite whenever front/postfix are rolled to a new
# image, including a `mailuVersion` bump (../values.yaml), NOT just --version changes.
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

exec "$(dirname "$0")/../../deploy.sh" mailu-mailserver "$@"
