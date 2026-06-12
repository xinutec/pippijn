#!/usr/bin/env bash
set -u
L=/home/pippijn/archive-upload.log; : > "$L"
echo "=== start $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$L"
rclone copy /home/pippijn/backup dash:Archive \
  --transfers 2 --checkers 2 --tpslimit 4 \
  --stats 5m --stats-one-line \
  --log-file "$L" --log-level INFO
echo "=== done rc=$? $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$L"
