#!/usr/bin/env bash
# The ingress controller's NetworkPolicy on amun, through the deploy plan
# (../../deploy.sh).
#
# The chart is not installed here. Its version, ../values.yaml and arguments are a
# row in xinutec-infra's plan/tables/helm.dhall, applied from the Mac with
# `plan-run helm --settings plan/settings.json --apply`.
#
# amun only. isis runs no ingress-nginx: its edge is the host's own nginx
# (nixos-config, `node.edge = "frontdoor"`). `--host` because no Dhall model
# places this tree.
#
# ingress-nginx is ARCHIVED upstream: best-effort maintenance ended March 2026 and the
# repo is read-only. amun holds 4.8.3; replacing it means adopting a Gateway API
# implementation, which is its own project (#1897).
#
# `controller.service.loadBalancerIP` in values.yaml is inert. There is no MetalLB here;
# k3s's built-in servicelb (klipper) assigns the node's own wg0 address (10.100.0.1),
# ignoring the requested 10.51.0.100. It is left alone because it has been harmless for
# years and editing the Service spec is a needless way to disturb a working external IP.
set -euo pipefail
exec "$(dirname "$0")/../../deploy.sh" ingress-nginx --host amun.xinutec.org "$@"
