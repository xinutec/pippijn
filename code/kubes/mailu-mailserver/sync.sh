#!/bin/sh

sudo helm upgrade --install mailu mailu/mailu --version 2.1.1 -n mailu-mailserver --create-namespace --values values.yaml --values secrets.yaml

# Workaround: chart 2.1.1's clamav probes check /tmp/clamd.pid which
# the official clamav-debian image doesn't create. Patch to use pgrep
# for clamd only (freshclam exits after updates and is non-critical).
# Also increase initialDelaySeconds since ClamAV needs time to download
# ~300 MB of signatures on first start.
sudo kubectl -n mailu-mailserver patch statefulset mailu-clamav --type=json -p='[
  {"op": "replace", "path": "/spec/template/spec/containers/0/readinessProbe/exec/command", "value": ["sh", "-c", "pgrep clamd"]},
  {"op": "replace", "path": "/spec/template/spec/containers/0/livenessProbe/exec/command", "value": ["sh", "-c", "pgrep clamd"]},
  {"op": "replace", "path": "/spec/template/spec/containers/0/livenessProbe/initialDelaySeconds", "value": 120}
]'
