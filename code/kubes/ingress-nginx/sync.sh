#!/usr/bin/env bash
# Deploy the shared nginx ingress controller. Run on the cluster host as root.
#
# This script used to pass no --version at all, which is exactly how the two clusters
# drifted apart: each got whatever was newest on the day it happened to be run (amun
# 4.8.3 from Nov 2023, isis 4.11.3 from Dec 2024). Pinned per host now:
#
#   isis  k8s 1.35  -> 4.15.1 (controller v1.15.1, supports k8s 1.31-1.35)
#   amun  k8s 1.32  -> 4.8.3  (frozen; see below)
#
# ingress-nginx is ARCHIVED upstream: best-effort maintenance ended March 2026 and the
# repo is read-only, so controller v1.15.1 is the last release there will ever be. This
# pin is terminal, not a step on a treadmill -- there will never be a newer one to move
# to. Replacing it means adopting a Gateway API implementation, which is its own project.
#
# amun is deliberately held at 4.8.3: it stays on NixOS 25.05 until it is reinstalled
# from scratch, and its ingress fronts mail and web today. Jumping it six minors on a
# cluster we intend to wipe is risk without payoff.
#
# `controller.service.loadBalancerIP` in values.yaml is inert. There is no MetalLB here;
# k3s's built-in servicelb (klipper) assigns the node's own wg0 address (amun 10.100.0.1,
# isis 10.100.0.2), ignoring the requested 10.51.0.100. It is left alone because it has
# been harmless for years and editing the Service spec is a needless way to disturb a
# working external IP.
set -euo pipefail

case "$(hostname -s)" in
  isis) version=4.15.1 ;;
  amun) version=4.8.3 ;;
  *) echo "no ingress-nginx version pinned for host '$(hostname -s)'" >&2; exit 1 ;;
esac

args=(
  ingress-nginx ingress-nginx
  --repo https://kubernetes.github.io/ingress-nginx
  --namespace ingress-nginx
  --create-namespace
  --version "$version"
  -f values.yaml
)

# dev-lint: pvc none
# Render gate. Unlike cert-manager this chart ships no values.schema.json, so a stale
# key would be silently ignored rather than rejected; the dry-run still catches template
# errors and CRD/API-version breakage before anything is applied.
sudo helm upgrade --install "${args[@]}" --dry-run >/dev/null
sudo helm upgrade --install "${args[@]}"
