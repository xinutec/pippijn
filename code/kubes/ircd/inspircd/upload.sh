#!/usr/bin/env bash

set -euxo pipefail

cd "$HOME/code/kubes/ircd/inspircd"

POD=$(sudo kubectl get pod -n ircd | grep '^inspircd' | awk '{print $1}')
HOST=org.xinutec.amun

# Same for the certs (encrypted)>
sudo kubectl get secret -n ircd irc-tls -o json | jq -r '.data."tls.crt"' | base64 -d > "inspircd/conf/$HOST/secret/cert.pem"
sudo kubectl get secret -n ircd irc-tls -o json | jq -r '.data."tls.key"' | base64 -d > "inspircd/conf/$HOST/secret/key.pem"

# Copy the certs into the container and REHASH.
sudo kubectl cp inspircd/conf/$HOST/secret "ircd/$POD:/etc/inspircd/conf/"
sudo kubectl cp permchannels.conf "ircd/$POD:/etc/inspircd/data/"
sudo kubectl exec --stdin --tty -n ircd "pod/$POD" -- /bin/bash -c 'kill -HUP 1'
