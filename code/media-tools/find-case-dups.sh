#!/usr/bin/env bash
set -u
export LC_ALL=C
for dir in Music media Videos Documents; do
  cd "/home/pippijn/$dir" 2>/dev/null || continue
  find . -type f -printf "%P\n" 2>/dev/null \
    | awk "{ lc=tolower(\$0); print lc \"\t\" \$0 }" \
    | sort -t"	" -k1,1 -s > /tmp/cd.lst
  cut -f1 /tmp/cd.lst | uniq -d > /tmp/cd.dups
  while IFS= read -r lc; do
    mapfile -t paths < <(awk -F"\t" -v k="$lc" "\$1==k{print \$2}" /tmp/cd.lst)
    h0=""; allsame=1
    for p in "${paths[@]}"; do
      h=$(sha256sum "$p" | cut -c1-64)
      [ -z "$h0" ] && h0="$h"
      [ "$h" = "$h0" ] || allsame=0
    done
    if [ "$allsame" = 1 ]; then
      echo "DUP  [$dir] (${#paths[@]} identical) ${paths[0]}"
    else
      echo "KEEP [$dir] (different content) ${paths[*]}"
    fi
  done < /tmp/cd.dups
done
