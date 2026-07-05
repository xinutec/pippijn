#!/usr/bin/env bash
# dev-lint: allow-no-strict-mode — rclone check exits non-zero when it finds
# differences (the result this script records per dir), so errexit is wrong here.
set -u
R=/home/pippijn/verify-media.out
: > "$R"
for d in Music media Videos Documents; do
  echo "=== $d ===" >> "$R"
  rclone check "/home/pippijn/$d" "dash:$d" --one-way --size-only 2>>"$R"
  echo "(rc=$?)" >> "$R"
done
echo "=== VERIFY DONE $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$R"
