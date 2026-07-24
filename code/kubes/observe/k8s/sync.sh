#!/usr/bin/env bash
# Apply the observe viewer manifests to isis, from the Mac. Content (runs +
# viewer page) is NOT deployed here — the observe repo's scripts/publish_run.sh
# rsyncs it into /srv/observe, which the pod mounts read-only.
set -euo pipefail
cd "$(dirname "$0")"

ssh root@isis 'mkdir -p /srv/observe/runs'
for f in ./*.yaml; do
  ssh root@isis 'kubectl apply -f -' < "$f"
done
ssh root@isis 'kubectl -n observe rollout status deploy/observe-viewer --timeout=180s'
