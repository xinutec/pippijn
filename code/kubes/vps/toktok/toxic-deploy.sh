#!/bin/sh

set -euxo pipefail

ssh toktok -t 'cd /src/workspace && bazel build --config=debug --config=linux-arm64-musl //toxic'
scp toktok:/src/workspace/bazel-bin/toxic/toxic .
gzip toxic
scp toxic.gz hermes.vpn:
rm toxic.gz
ssh hermes.vpn 'rm toxic'
ssh hermes.vpn 'gunzip toxic.gz'
