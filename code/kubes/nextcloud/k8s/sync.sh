#!/usr/bin/env bash
# Apply the Nextcloud manifests to isis, through the deploy plan (../../deploy.sh).
#
# `--host` because no Dhall model places this tree; deploy.sh explains why there
# is no default. Its Redis is redis.yaml here since 2026-10-03, no longer
# bitnami's chart. The secrets are ../nextcloud/secret.sh, and the `redis` one
# predates it (made by that chart, kept when it went).
set -euo pipefail
exec "$(dirname "$0")/../../deploy.sh" nextcloud --host isis.xinutec.org "$@"
