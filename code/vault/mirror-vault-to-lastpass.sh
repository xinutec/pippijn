#!/bin/sh
# RETIRED 2026-06-11. This used `lpass edit`/`lpass rm`, which CORRUPT the
# local LastPass vault blob on this account (proven that night — see
# project_flux_vaultwarden memory). Use sync-vw-to-lastpass.sh instead:
# it adds via `lpass import` (safe) and emits a delete-list you action in
# the LastPass web vault (the CLI delete is unsafe). Do not resurrect this.
echo "retired — use ./sync-vw-to-lastpass.sh"; exit 1
