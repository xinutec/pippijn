#!/usr/bin/env bash
# Deploy cert-manager + the letsencrypt ClusterIssuers. Run on the cluster host as root.
#
# The chart version is pinned PER HOST, because the two clusters sit on different
# Kubernetes versions and cert-manager supports only a narrow window of them:
#
#   isis  k8s 1.35  -> v1.20.3  (1.20 supports k8s 1.32-1.35)
#   amun  k8s 1.32  -> v1.16.2  (frozen; see below)
#
# v1.21 (k8s 1.33-1.36) is the newest release. amun cannot run it at all on k8s 1.32,
# so v1.20 is a hard ceiling THERE. isis is not bound by that -- these pins are per
# host, so isis could take v1.21 today. It is held at v1.20.3 by choice: v1.21.0 is two
# weeks old with no patch release yet, and v1.20 stays supported until v1.22 ships.
# Revisit when v1.21.1 lands. The fleet check will report isis as one minor behind in
# the meantime, and that report is CORRECT -- it is a deliberate lag, not a false alarm,
# so leave the warning standing rather than suppressing it.
#
# amun is deliberately held: it stays on NixOS 25.05 until it is reinstalled from
# scratch, and its cert-manager renews everything without error. Upgrading a cluster
# we intend to wipe is risk without payoff, so its pin stays put. The divergence
# between the two hosts is the plan, not drift to be tidied away.
set -euo pipefail

case "$(hostname -s)" in
  isis) version=v1.20.3 ;;
  amun) version=v1.16.2 ;;
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
