#!/usr/bin/env bash
# dev-lint: allow-no-strict-mode — dup analysis: per-item probes (stat/ffprobe) may
# exit non-zero and are handled inline; errexit would abort mid-report.
set -u
export LC_ALL=C
meta() { ffprobe -v error -show_entries format=duration,bit_rate -of default=noprint_wrappers=1:nokey=1 "$1" 2>/dev/null | tr "\n" " "; }
for dir in Music media; do
  cd "/home/pippijn/$dir" 2>/dev/null || continue
  find . -type f -printf "%P\n" 2>/dev/null \
    | awk "{ lc=tolower(\$0); print lc \"\t\" \$0 }" \
    | sort -t"	" -k1,1 -s > /tmp/cd.lst
  cut -f1 /tmp/cd.lst | uniq -d > /tmp/cd.dups
  while IFS= read -r lc; do
    mapfile -t paths < <(awk -F"\t" -v k="$lc" "\$1==k{print \$2}" /tmp/cd.lst)
    a="${paths[0]}"; b="${paths[1]}"
    sa=$(stat -c%s "$a"); sb=$(stat -c%s "$b")
    case "$a" in
      *.mp3|*.MP3|*.flac|*.ogg|*.m4a)
        ma=$(meta "$a"); mb=$(meta "$b")
        echo "[$dir] $a"
        echo "    A: dur+br=[$ma] size=$sa  | B: dur+br=[$mb] size=$sb" ;;
      *)
        # image: dimensions
        da=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$a" 2>/dev/null)
        db=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$b" 2>/dev/null)
        echo "[$dir] $a"
        echo "    A: ${da} size=$sa  | B(.jpg): ${db} size=$sb" ;;
    esac
  done < /tmp/cd.dups
done
