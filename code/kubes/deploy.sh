#!/usr/bin/env bash
# Deploy one app to isis, through the reconciler.
#
# THE single implementation, and the per-app `sync.sh` scripts are doors onto it.
# Ten copies of one procedure differing only in namespace and file list DIVERGE:
# one loses the `rollout restart` line the others have, a ConfigMap change applies
# and never takes effect, and nothing in the deploy path notices — the drift
# collector finds it.
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
# ⚠ NO `--host`. It used to say `--host isis`, which was right fourteen times in
# fifteen and silently wrong for the one tree on amun — and it meant this script,
# not the model, decided which cluster got the manifests. `plan-run` reads
# `dhall/clusters.json` now and refuses a `--host` that contradicts a model, so
# `deploy.sh amun` reaches amun for the first time.
#
# A tree with NO model has to be told: `deploy.sh ircd --host isis.xinutec.org`.
# That is deliberate rather than a regression — there is no default, because a
# wrong cluster applies cleanly against an empty namespace and reads like a first
# deploy (#692). The seven unmodelled trees joining the model retires the flag.
exec "$exe" deploy \
  --settings "${INFRA}/plan/settings.json" \
  --app "$app" \
  --local-repo "$KUBES" \
  --host-dir "$HOST_DIR" \
  --roll-forward \
  --apply \
  "$@"
