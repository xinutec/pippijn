#!/usr/bin/env bash
# dev-lint: allow-no-strict-mode — rclone check exits non-zero on differences and
# the per-dir grep may not match; both are expected, so errexit is wrong here.
for d in Photos Videos; do
  rclone check "/home/pippijn/$d" "dash:$d" --one-way --size-only --transfers 2 --checkers 2 --tpslimit 4 > "/home/pippijn/check-$d.out" 2> "/home/pippijn/check-$d.err"
  echo "=== $d ==="
  grep -E "missing|differences|matching files|ERROR" "/home/pippijn/check-$d.err" | tail -4
done
echo DONE2
