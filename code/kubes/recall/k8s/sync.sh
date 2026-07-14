#!/usr/bin/env bash
# Deploy recall's fleet tier to isis. Run on the isis host (as root) after CI has
# published xinutec/recall:latest. Applies the manifests in order and waits for rollout.
#
# What runs here: the FastAPI api + web + the sync ingest. NO ML — the Mac keeps capture,
# ASR, diarization and the LLM (all Apple-Silicon-bound). Isis is the system of record.
#
# ONE-TIME prerequisites (not done here):
#   - ./secret.sh   (creates recall-secret with the Mac's SYNC_TOKEN)
#
# Deliberately NO Ingress and NO DNS record. recall is reachable only on Isis's
# WireGuard address (10.100.0.2:8000), via a hostPort pinned to that IP — see
# 02-deployment.yaml. The shared nginx ingress answers on Isis's *public* IP whatever
# DNS says, so putting recall behind it would publish household audio to the internet
# and call it private. This is the one app in the fleet that must not use it.
set -euo pipefail
cd "$(dirname "$0")"

kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-pvc.yaml
kubectl apply -f 02-deployment.yaml
kubectl apply -f 03-service.yaml
kubectl apply -f 04-networkpolicy.yaml

# Pick up a freshly-pushed :latest even when the tag is unchanged.
kubectl -n recall rollout restart deploy/recall
kubectl -n recall rollout status deploy/recall --timeout=180s
