#!/usr/bin/env bash
set -u
L=/home/pippijn/nc-sync.log; : > "$L"
for d in Music media; do
  echo "=== sync $d $(date -u +%H:%M:%SZ) ===" >> "$L"
  rclone sync "/home/pippijn/$d" "dash:$d" \
    --track-renames --track-renames-strategy modtime,size \
    --create-empty-src-dirs --transfers 2 --checkers 2 --tpslimit 4 \
    --max-delete 100 --stats 2m --stats-one-line \
    --log-file "$L" --log-level INFO
  echo "=== done $d rc=$? $(date -u +%H:%M:%SZ) ===" >> "$L"
done
echo "ALL DONE $(date -u +%H:%M:%SZ)" >> "$L"
