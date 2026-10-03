#!/usr/bin/env bash
# The letsencrypt ClusterIssuers on amun. Run there as root.
#
# The chart is not installed here any more. Its version and arguments are a row in
# xinutec-infra's plan/tables/helm.dhall, applied from the Mac with
# `plan-run helm --settings plan/settings.json --apply`, which first checks that
# the release Helm has on record is what that row renders. The version used to be
# written here as well, and the two had nothing comparing them.
#
# amun only: isis's host nginx gets its certificates from NixOS `security.acme`.
#
# amun stays on NixOS 25.05 (k8s 1.32) until it is reinstalled, which is months away,
# so its cert-manager is kept current within what k8s 1.32 supports: v1.20 is the last
# minor that does. Upgraded 2026-10-02 one minor at a time (1.17, 1.18, 1.19, 1.20),
# each checked with every Certificate Ready and a webhook dry run, then a staging
# issuance end to end. Since 1.18 a renewal makes a new private key; nothing pins
# ours (no TLSA records).
set -euo pipefail

# dev-lint: pvc none
# The ClusterIssuers use the deprecated `solvers.http01.ingress.class` field. It is
# still present in the 1.20 CRD, so it keeps working; `ingressClassName` is the
# replacement for when it is finally removed.
sudo kubectl apply -f .
