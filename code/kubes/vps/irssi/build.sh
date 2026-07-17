#!/usr/bin/env bash

set -euxo pipefail

for home in home/*; do
  user="${home/home\/}"
  port="$(cat $home/.port)"
  sed -e "s/\${user}/$user/g;s/\${port}/$port/g" template/irssi.yaml > "$user.yaml"
done
