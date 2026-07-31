#!/usr/bin/env bash
# Deploy one app to isis, through the reconciler.
#
# THE single implementation. Until 2026-07-31 there were ten hand-written
# `sync.sh` scripts, 323 lines, six of them the same procedure differing only in
# namespace and file list — and they had diverged. observe's copy was missing the
# `rollout restart` line the others had, so a ConfigMap change applied and never
# took effect: the nginx telemetry endpoint was live-but-inert for a day, and the
# drift collector found it rather than anything in the deploy path.
#
# What this does that the scripts did not:
#
#   * refuses unless the repo is on main, the app's manifests are committed, HEAD
#     is pushed, and the host's checkout is at that same commit;
#   * excludes `*-held.yaml`, which a hand-listed `-f` sequence only got right by
#     accident and would have stopped getting right the moment someone added a
#     file;
#   * applies nothing when the cluster already matches, where the scripts applied
#     unconditionally;
#   * restarts only workloads on a `:latest` tag — a pinned database cannot be
#     stale — and only when the registry says the running image is behind.
#
# BEHAVIOUR CHANGE worth knowing: the scripts ran `kubectl apply` from this
# machine against LOCAL files, so they could deploy uncommitted edits. This
# deploys the HOST's checkout, which the guards above have proven equal to
# origin/main. Iterating by deploying an uncommitted manifest is no longer
# possible — that is the point of the guards, not an oversight.
#
# Design and reasoning: xinutec-infra/plan/README.md.
set -euo pipefail

app="${1:?usage: deploy.sh APP [extra plan-run args…]}"
shift

INFRA="${INFRA:-$HOME/Code/xinutec-infra}"
KUBES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="${HOST_DIR:-/home/pippijn/code/kubes}"

# Built rather than run from a checkout: the same store path the fleetwatch
# deploy-drift collector observes with, so what reports drift and what fixes it
# cannot be different code.
exe="$(nix build --no-link --print-out-paths "${INFRA}#plan-run")/bin/plan-run"

# `--roll-forward` because that is what running a sync script always meant: put
# the workloads on the current `:latest`. Without it a deploy converges the
# standing invariants and leaves running pods alone.
exec "$exe" deploy \
  --settings "${INFRA}/plan/settings.json" \
  --app "$app" \
  --host isis \
  --local-repo "$KUBES" \
  --host-dir "$HOST_DIR" \
  --roll-forward \
  --apply \
  "$@"
