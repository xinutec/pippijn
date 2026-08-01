#!/usr/bin/env bash
# Apply the health manifests to isis.
#
# A thin entry point on purpose. The procedure this used to spell out by hand
# lived in ten near-identical copies, and one of them had silently lost a line —
# see ../../deploy.sh, which is now the only implementation.
#
# health was the one app with a k8s/ directory and no wrapper, and it is not in
# the README's 'Not covered' list — it is the six-line procedure like the rest,
# it just never got folded in. Until now its manifests were applied by hand:
# health/scripts/deploy.sh in the health repo builds the image and does a
# rollout restart, but applies no manifests at all, so an env-var change reached
# the cluster only if someone remembered to kubectl apply it.
set -euo pipefail
exec "$(dirname "$0")/../../deploy.sh" health "$@"
