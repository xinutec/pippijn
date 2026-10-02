#!/usr/bin/env bash
# Deploy cert-manager + the letsencrypt ClusterIssuers on amun. Run there as root.
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

case "$(hostname -s)" in
  amun) version=v1.20.4 ;;
  *) echo "no cert-manager version pinned for host '$(hostname -s)'" >&2; exit 1 ;;
esac

args=(
  cert-manager jetstack/cert-manager
  --namespace cert-manager
  --create-namespace
  --version "$version"
  --set crds.enabled=true
  --set prometheus.enabled=false
)

# dev-lint: pvc none
sudo helm repo update jetstack

# Schema gate. This chart ships a values.schema.json with additionalProperties:false,
# so if a future chart renames or drops one of the --set keys above, this dry-run fails
# loudly BEFORE anything is applied, instead of the flag being silently ignored.
sudo helm upgrade --install "${args[@]}" --dry-run >/dev/null
sudo helm upgrade --install "${args[@]}"

# The ClusterIssuers use the deprecated `solvers.http01.ingress.class` field. It is
# still present in the 1.20 CRD, so it keeps working; `ingressClassName` is the
# replacement for when it is finally removed.
sudo kubectl apply -f .
