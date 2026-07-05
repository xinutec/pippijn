#!/usr/bin/env bash
# dev-lint: allow-no-strict-mode — rclone check exits non-zero when it finds
# differences (the result this script greps out and reports), so errexit is wrong.
# Exhaustive byte-level verification: every amun Music file vs NC (downloads NC copy, compares content).
cd /home/pippijn
rclone check /home/pippijn/Music dash:Music --download \
  --transfers 2 --checkers 2 --tpslimit 4 \
  --stats 5m --stats-one-line \
  --differ /home/pippijn/music-differ.txt \
  --missing-on-dst /home/pippijn/music-missing.txt \
  > /home/pippijn/music-check.log 2>&1
echo "=== MUSIC EXHAUSTIVE BYTE-CHECK ==="
grep -E "differences|missing|matching files|ERROR" /home/pippijn/music-check.log | tail -6
echo "missing-on-NC count: $(wc -l < /home/pippijn/music-missing.txt 2>/dev/null)"
echo "byte-differ count:   $(wc -l < /home/pippijn/music-differ.txt 2>/dev/null)"
echo MUSICCHECKDONE
