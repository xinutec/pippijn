#!/usr/bin/env bash
for d in Photos Videos; do
  rclone check "/home/pippijn/$d" "dash:$d" --one-way --size-only --transfers 2 --checkers 2 --tpslimit 4 > "/home/pippijn/check-$d.out" 2> "/home/pippijn/check-$d.err"
  echo "=== $d ==="
  grep -E "missing|differences|matching files|ERROR" "/home/pippijn/check-$d.err" | tail -4
done
echo DONE2
