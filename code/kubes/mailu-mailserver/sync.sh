#!/bin/sh

sudo helm upgrade --install mailu mailu/mailu --version 2.1.1 -n mailu-mailserver --create-namespace --values values.yaml --values secrets.yaml

# Workaround: chart 2.1.1's clamav probes check /tmp/clamd.pid which
# the official clamav-debian image doesn't create, and uses pgrep which
# isn't installed. Use clamdscan --ping (ClamAV's built-in health check).
# 300s initial delay gives time for signature download + load on first start.
sudo kubectl -n mailu-mailserver patch statefulset mailu-clamav --type=json -p='[
  {"op": "replace", "path": "/spec/template/spec/containers/0/readinessProbe/exec/command", "value": ["clamdscan", "--ping", "30"]},
  {"op": "replace", "path": "/spec/template/spec/containers/0/livenessProbe/exec/command", "value": ["clamdscan", "--ping", "30"]},
  {"op": "replace", "path": "/spec/template/spec/containers/0/livenessProbe/initialDelaySeconds", "value": 300}
]'
