#!/usr/bin/env bash
# Apply the observe viewer manifests to isis.
#
# Content (runs + viewer page) is NOT deployed here — the observe repo's
# scripts/publish_run.sh rsyncs it into /srv/observe, which the pod mounts
# read-only. The directories have to exist before the pod can mount them, which
# is the one thing this app needs beyond the shared path.
set -euo pipefail
ssh root@isis 'mkdir -p /srv/observe/runs /srv/observe/web'
exec "$(dirname "$0")/../../deploy.sh" observe "$@"
