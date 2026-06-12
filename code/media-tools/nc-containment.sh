#!/usr/bin/env bash
cd /home/pippijn
for d in Documents Media Music Photos Videos; do
  out=$(rclone check "/home/pippijn/$d" "dash:$d" --one-way --size-only --transfers 2 --checkers 2 --tpslimit 4 2>&1)
  miss=$(echo "$out" | grep -oE "[0-9]+ files missing" | head -1)
  match=$(echo "$out" | grep -oE "[0-9]+ matching files" | head -1)
  printf "%-12s missing-from-NC: %-20s %s\n" "$d" "${miss:-0}" "$match"
done
echo "DONE"
