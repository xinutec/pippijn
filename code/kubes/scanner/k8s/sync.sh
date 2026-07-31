#!/usr/bin/env bash
# Apply the scanner manifests to isis.
#
# A thin entry point on purpose. The procedure this used to spell out by hand
# lived in ten near-identical copies, and one of them had silently lost a line —
# see ../../deploy.sh, which is now the only implementation.
set -euo pipefail
exec "$(dirname "$0")/../../deploy.sh" scanner "$@"
