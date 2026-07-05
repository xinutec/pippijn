#!/usr/bin/env bash
# dev-lint: allow-no-strict-mode — rclone check exits non-zero on differences (the
# divergence this script goes on to classify), so errexit would abort the report.
cd /home/pippijn
echo "[1/4] capturing divergence lists..."
rclone check /home/pippijn/Photos dash:Photos --one-way --size-only \
  --differ /home/pippijn/p-differ.txt --missing-on-dst /home/pippijn/p-missing.txt \
  --transfers 2 --checkers 2 --tpslimit 4 2>/home/pippijn/p-check.err
echo "[2/4] amun photo sizes..."
rclone lsl /home/pippijn/Photos 2>/dev/null | sed -E "s/^ *([0-9]+) [0-9-]+ [0-9:.]+ /\1\t/" > /home/pippijn/amun-photo.tsv
echo "[3/4] NC photo sizes..."
rclone lsl dash:Photos 2>/dev/null | sed -E "s/^ *([0-9]+) [0-9-]+ [0-9:.]+ /\1\t/" > /home/pippijn/nc-photo.tsv
echo "[4/4] classifying..."
python3 - <<"PY"
amun={}; nc={}
for line in open("/home/pippijn/amun-photo.tsv"):
    s,_,p=line.rstrip("\n").partition("\t"); amun[p]=int(s) if s.isdigit() else 0
for line in open("/home/pippijn/nc-photo.tsv"):
    s,_,p=line.rstrip("\n").partition("\t"); nc[p]=int(s) if s.isdigit() else 0
missing=[l.strip() for l in open("/home/pippijn/p-missing.txt") if l.strip()]
differ=[l.strip() for l in open("/home/pippijn/p-differ.txt") if l.strip()]
miss_bytes=sum(amun.get(p,0) for p in missing)
abig=nbig=eq=0; abig_bytes=0
for p in differ:
    a=amun.get(p,0); n=nc.get(p,0)
    if a>n: abig+=1; abig_bytes+=a-n
    elif n>a: nbig+=1
    else: eq+=1
gb=lambda b: round(b/1073741824,2)
print(f"amun-only (add): {len(missing)} files, {gb(miss_bytes)} GiB")
print(f"size-differ total: {len(differ)}")
print(f"  amun LARGER (push up): {abig}  (+{gb(abig_bytes)} GiB of better data)")
print(f"  NC LARGER (keep NC):   {nbig}")
print(f"  same size (other diff): {eq}")
PY
echo DIVDONE
