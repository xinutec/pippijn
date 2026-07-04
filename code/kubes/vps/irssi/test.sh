#!/bin/sh

set -euxo pipefail

docker build -t xinutec/irssi:test .
docker run \
  --name irssi-test \
  --rm \
  -p 2345:22 \
  --env IRSSI_USER=pippijn \
  -it xinutec/irssi:test
