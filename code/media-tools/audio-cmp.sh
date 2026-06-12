#!/usr/bin/env bash
set -u
export LC_ALL=C
audiomd5() { ffmpeg -v error -i "$1" -map 0:a -c copy -f md5 - 2>/dev/null | sed "s/MD5=//"; }
for dir in Music media; do
  cd "/home/pippijn/$dir" 2>/dev/null || continue
  find . -type f -printf "%P\n" 2>/dev/null \
    | awk "{ lc=tolower(\$0); print lc \"\t\" \$0 }" \
    | sort -t"	" -k1,1 -s > /tmp/cd.lst
  cut -f1 /tmp/cd.lst | uniq -d > /tmp/cd.dups
  while IFS= read -r lc; do
    mapfile -t paths < <(awk -F"\t" -v k="$lc" "\$1==k{print \$2}" /tmp/cd.lst)
    a="${paths[0]}"; b="${paths[1]}"
    case "$a" in
      *.mp3|*.MP3|*.flac|*.ogg|*.m4a)
        ha=$(audiomd5 "$a"); hb=$(audiomd5 "$b")
        if [ -n "$ha" ] && [ "$ha" = "$hb" ]; then
          echo "SAME-AUDIO (only tags differ) [$dir] ${a%/*}/${a##*/}"
        else
          echo "DIFF-AUDIO (real difference)   [$dir] $a"
        fi ;;
      *)
        echo "NON-AUDIO (compare manually)   [$dir] $a <> $b" ;;
    esac
  done < /tmp/cd.dups
done
