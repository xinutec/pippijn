#!/usr/bin/env bash
# The letsencrypt ClusterIssuers on amun, through the deploy plan (../../deploy.sh).
#
# The chart is not installed here. Its version and arguments are a row in
# xinutec-infra's plan/tables/helm.dhall, applied from the Mac with
# `plan-run helm --settings plan/settings.json --apply`.
#
# amun only: isis's host nginx gets its certificates from NixOS `security.acme`.
# The cluster comes from ../../dhall/placed.dhall, since no model places this tree.
#
# amun stays on NixOS 25.05 (k8s 1.32) until it is reinstalled, which is months away,
# so its cert-manager is kept current within what k8s 1.32 supports: v1.20 is the last
# minor that does. Upgraded 2026-10-02 one minor at a time (1.17, 1.18, 1.19, 1.20),
# each checked with every Certificate Ready and a webhook dry run, then a staging
# issuance end to end. Since 1.18 a renewal makes a new private key; nothing pins
# ours (no TLSA records).
#
# The ClusterIssuers use the deprecated `solvers.http01.ingress.class` field. It is
# still present in the 1.20 CRD, so it keeps working; `ingressClassName` is the
# replacement for when it is finally removed.
set -euo pipefail
exec "$(dirname "$0")/../../deploy.sh" cert-manager "$@"
