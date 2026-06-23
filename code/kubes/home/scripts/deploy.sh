#!/usr/bin/env bash
# Roll out the latest xinutec/home:latest image on isis k3s.
# The image is built+pushed by CI (push to main → GitHub Actions). This script
# just triggers a rollout to pick up the new :latest digest.
set -euo pipefail

ssh root@isis.xinutec.org \
  'kubectl -n home rollout restart deploy/home && \
   kubectl -n home rollout status deploy/home --timeout=180s'
