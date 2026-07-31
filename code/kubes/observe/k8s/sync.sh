#!/usr/bin/env bash
# Apply the observe viewer manifests to isis, from the Mac. Content (runs +
# viewer page) is NOT deployed here — the observe repo's scripts/publish_run.sh
# rsyncs it into /srv/observe, which the pod mounts read-only.
set -euo pipefail
cd "$(dirname "$0")"

ssh root@isis 'mkdir -p /srv/observe/runs /srv/observe/web'

# A ConfigMap change does not touch the Deployment's spec, so nothing rolls and
# nginx keeps serving the config it started with — it reloads on signal, never
# on the mounted file changing. This script used to apply and then wait on
# `rollout status`, which returned "successfully rolled out" immediately and
# truthfully: there was nothing to roll. The nginx telemetry endpoint sat
# applied-but-inert that way from 2026-07-30 to 2026-07-31, reported as a
# successful deploy the whole time, and was found by the drift collector rather
# than by anything here.
#
# So: notice when the ConfigMap actually changed, and restart on that. `kubectl
# apply` prints "configured" when it changed the object and "unchanged" when it
# did not, which is the cheapest honest signal available without templating a
# checksum into the pod annotations.
changed=0
for f in ./*.yaml; do
  out=$(ssh root@isis 'kubectl apply -f -' < "$f")
  echo "$out"
  case "$f$out" in
    *configmap*configured*) changed=1 ;;
  esac
done

if [ "$changed" -eq 1 ]; then
  echo "configmap changed — restarting so nginx loads it"
  ssh root@isis 'kubectl -n observe rollout restart deploy/observe-viewer'
fi

ssh root@isis 'kubectl -n observe rollout status deploy/observe-viewer --timeout=180s'
