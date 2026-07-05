#!/usr/bin/env bash
# dev-lint: allow-no-strict-mode — rclone's non-zero is logged as rc=$? per dir and
# must not abort the loop before every dir is copied.
set -u
LOG=/home/pippijn/rclone-media-to-nc.log
: > "$LOG"
for d in Music media Videos Documents; do
  echo "=== starting $d $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"
  rclone copy "/home/pippijn/$d" "dash:$d" \
    --transfers 2 --checkers 2 --tpslimit 4 \
    --stats 5m --stats-one-line \
    --log-file "$LOG" --log-level INFO
  echo "=== done $d rc=$? $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"
done
echo "=== ALL DONE $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"
