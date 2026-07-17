#!/usr/bin/env bash

set -euo pipefail

exec workspace/tools/built/dev/test_dev_container.sh "xinutec/toktok:test" "$@"
