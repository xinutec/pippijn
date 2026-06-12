#!/usr/bin/env bash
set -u
R=/home/pippijn/verify-media.out
: > "$R"
for d in Music media Videos Documents; do
  echo "=== $d ===" >> "$R"
  rclone check "/home/pippijn/$d" "dash:$d" --one-way --size-only 2>>"$R"
  echo "(rc=$?)" >> "$R"
done
echo "=== VERIFY DONE $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$R"
