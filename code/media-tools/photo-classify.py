#!/usr/bin/env python3
amun = {}
nc = {}
for line in open("/home/pippijn/amun-photo.tsv"):
    s, _, p = line.rstrip("\n").partition("\t")
    amun[p] = int(s) if s.isdigit() else 0
for line in open("/home/pippijn/nc-photo.tsv"):
    s, _, p = line.rstrip("\n").partition("\t")
    nc[p] = int(s) if s.isdigit() else 0
differ = [l.strip() for l in open("/home/pippijn/p-differ.txt") if l.strip()]
miss = [l.strip() for l in open("/home/pippijn/p-missing.txt") if l.strip()]
al = [p for p in differ if amun.get(p, 0) > nc.get(p, 0)]
nl = [p for p in differ if nc.get(p, 0) > amun.get(p, 0)]
open("/home/pippijn/sample-nc-larger.txt", "w").write("\n".join(nl[:6]) + "\n")
open("/home/pippijn/sample-missing.txt", "w").write("\n".join(miss[:6]) + "\n")
print("amun-larger ALL (%d):" % len(al))
for p in al:
    print("   %s   amun=%s  NC=%s" % (p, amun.get(p), nc.get(p)))
print("nc-larger sample:")
for p in nl[:6]:
    print("   %s   amun=%s  NC=%s" % (p, amun.get(p), nc.get(p)))
print("amun-only sample:")
for p in miss[:6]:
    print("   %s   %s bytes" % (p, amun.get(p)))
