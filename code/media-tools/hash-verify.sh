#!/usr/bin/env bash
# dev-lint: allow-no-strict-mode — a sampling verifier: per-file sha256sum/rclone-cat/
# grep misses are counted and reported (NOT-ON-NC / MISMATCH), not fatal.
cd /home/pippijn
EMPTY=$(printf '' | sha256sum | cut -d' ' -f1)

sample_path_based() {
  local d="$1" n="$2" exclude="$3"
  ( cd "/home/pippijn/$d" && find . -type f ! -type l 2>/dev/null | sed 's|^\./||' ) > /tmp/lst.txt
  if [ -n "$exclude" ] && [ -f "$exclude" ]; then
    grep -vxF -f "$exclude" /tmp/lst.txt > /tmp/lst2.txt && mv /tmp/lst2.txt /tmp/lst.txt
  fi
  local ok=0 bad=0 miss=0 tot=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    tot=$((tot+1))
    ah=$(sha256sum "/home/pippijn/$d/$f" 2>/dev/null | cut -d' ' -f1)
    nh=$(rclone cat "dash:$d/$f" --tpslimit 4 2>/dev/null | sha256sum | cut -d' ' -f1)
    if [ "$nh" = "$EMPTY" ] || [ -z "$nh" ]; then miss=$((miss+1)); echo "  NOT-ON-NC: $d/$f"
    elif [ "$ah" = "$nh" ]; then ok=$((ok+1))
    else bad=$((bad+1)); echo "  MISMATCH: $d/$f"; fi
  done < <(shuf /tmp/lst.txt | head -n "$n")
  echo "$d: sampled=$tot  BYTE-IDENTICAL=$ok  mismatch=$bad  not-on-NC=$miss"
}

sample_videos() {
  local n="$1"
  ( cd /home/pippijn/Videos && find . -type f ! -type l 2>/dev/null ) | sed 's|.*/||' > /tmp/vlst.txt
  rclone lsf -R --files-only dash:Videos 2>/dev/null > /tmp/ncv.txt
  local ok=0 bad=0 miss=0 tot=0
  while IFS= read -r bn; do
    [ -z "$bn" ] && continue
    tot=$((tot+1))
    ap=$(find /home/pippijn/Videos -name "$bn" -type f 2>/dev/null | head -1)
    np=$(grep -F "/$bn" /tmp/ncv.txt | head -1)
    ah=$(sha256sum "$ap" 2>/dev/null | cut -d' ' -f1)
    nh=$(rclone cat "dash:Videos/$np" --tpslimit 4 2>/dev/null | sha256sum | cut -d' ' -f1)
    if [ -z "$np" ] || [ "$nh" = "$EMPTY" ]; then miss=$((miss+1)); echo "  NOT-ON-NC: Videos/$bn"
    elif [ "$ah" = "$nh" ]; then ok=$((ok+1))
    else bad=$((bad+1)); echo "  MISMATCH: Videos/$bn"; fi
  done < <(shuf /tmp/vlst.txt | head -n "$n")
  echo "Videos: sampled=$tot  BYTE-IDENTICAL=$ok  mismatch=$bad  not-on-NC=$miss"
}

sample_path_based Documents 12 ""
sample_path_based Media 12 ""
sample_path_based Music 12 ""
sample_path_based Photos 15 /home/pippijn/p-differ.txt
sample_videos 4
echo HASHVERIFYDONE
