#!/bin/sh

set -euo pipefail

exec workspace/tools/built/dev/deploy_dev_container.sh "xinutec/toktok:latest" "$@"
