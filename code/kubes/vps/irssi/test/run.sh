#!/usr/bin/env bash
# The send path's tests. Plain perl — the same interpreter irssi embeds, so no
# toolchain is needed beyond what the image already has.
#
# `test.sh` beside this builds and runs the whole image; these are the unit and
# transport tests for the two scripts that let the messages archive speak, and
# they run in under a second without docker.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

status=0
for t in ./*.t; do
  echo "== $t"
  perl "$t" || status=1
done

exit "$status"
