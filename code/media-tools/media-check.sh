#!/usr/bin/env bash
# Exhaustive byte-level verification: every amun Media file vs NC (downloads NC copy, compares content).
cd /home/pippijn
rclone check /home/pippijn/Media dash:Media --download \
  --transfers 2 --checkers 2 --tpslimit 4 \
  --differ /home/pippijn/media-differ.txt \
  --missing-on-dst /home/pippijn/media-missing.txt \
  > /home/pippijn/media-check.log 2>&1
echo "=== MEDIA EXHAUSTIVE BYTE-CHECK ==="
grep -E "differences|missing|matching files|ERROR" /home/pippijn/media-check.log | tail -6
echo "missing-on-NC count: $(wc -l < /home/pippijn/media-missing.txt 2>/dev/null)"
echo "byte-differ count:   $(wc -l < /home/pippijn/media-differ.txt 2>/dev/null)"
echo MEDIACHECKDONE
