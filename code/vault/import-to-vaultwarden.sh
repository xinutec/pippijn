#!/usr/bin/env nix-shell
#!nix-shell -i bash -p bitwarden-cli python3
# One-time import of a cleaned Google-passwords CSV into Vaultwarden.
# Prompts for your master password (twice: login + unlock) — the password
# never leaves this terminal. Run from the Mac with the VPN tunnel active.
#
# Usage: ./import-to-vaultwarden.sh <cleaned.csv>
set -euo pipefail

CSV="${1:?usage: $0 <cleaned.csv>}"
[ -f "$CSV" ] || { echo "no such file: $CSV"; exit 1; }

export BITWARDENCLI_APPDATA_DIR="$(mktemp -d)"
trap 'bw logout >/dev/null 2>&1 || true; rm -rf "$BITWARDENCLI_APPDATA_DIR"' EXIT

bw config server https://vault.xinutec.org
echo "— log in (email + master password) —"
bw login pip88nl@gmail.com
echo "— unlock to get a session —"
SESSION=$(bw unlock --raw)
echo "— importing —"
bw import chromecsv "$CSV" --session "$SESSION"
echo "— verifying —"
COUNT=$(bw list items --session "$SESSION" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
echo "items now in vault: $COUNT"
echo "Done. You can now check https://vault.xinutec.org"
