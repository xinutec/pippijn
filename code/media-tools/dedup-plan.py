import os, sys, subprocess
sys.stdout.reconfigure(errors="replace")
from collections import defaultdict

def probe(path):
    try:
        o=subprocess.check_output(["ffprobe","-v","error","-show_entries",
          "format=duration,bit_rate","-of","default=noprint_wrappers=1:nokey=1",path],
          stderr=subprocess.DEVNULL).decode("utf-8","replace").split()
        dur=float(o[0]) if o and o[0] not in("N/A","") else 0.0
        br =int(o[1]) if len(o)>1 and o[1] not in("N/A","") else 0
        return dur,br
    except Exception: return 0.0,0

def sz(p):
    try: return os.path.getsize(p)
    except Exception: return 0

def plan_for(root):
    rels=[]
    for dp,dn,fns in os.walk(root):
        for fn in fns: rels.append(os.path.relpath(os.path.join(dp,fn),root))
    cnt=defaultdict(int)
    for r in rels:
        p=r.split("/")
        for i in range(1,len(p)): cnt["/".join(p[:i])]+=1
    canon={"":""}; bydepth=defaultdict(list)
    for d in cnt: bydepth[d.count("/")].append(d)
    for depth in sorted(bydepth):
        g=defaultdict(list)
        for d in bydepth[depth]:
            par,nm=(d.rsplit("/",1) if "/" in d else ("",d))
            g[(canon[par],nm.lower())].append((d,nm))
        for (cp,ln),mem in g.items():
            best=max(mem,key=lambda m:cnt[m[0]])[1]
            cpath=(cp+"/"+best) if cp else best
            for d,_ in mem: canon[d]=cpath
    fg=defaultdict(list)
    for r in rels:
        d,fn=(r.rsplit("/",1) if "/" in r else ("",r))
        fg[(canon[d],fn.lower())].append((r,fn,d))
    quar=[]; moves=[]; amb=[]; kip=0
    for (cd,lfn),mem in fg.items():
        if len(mem)==1:
            r,fn,d=mem[0]; tgt=(cd+"/"+fn) if cd else fn
            if r==tgt: kip+=1
            else: moves.append((r,tgt))
            continue
        info=[(r,fn,d,*probe(os.path.join(root,r)),sz(os.path.join(root,r))) for r,fn,d in mem]
        durs=[x[3] for x in info]
        if max(durs)-min(durs)>10.0: amb.append(info); continue
        keep=max(info,key=lambda x:(x[4],x[5]))
        tgt=(cd+"/"+keep[1]) if cd else keep[1]
        if keep[0]!=tgt: moves.append((keep[0],tgt)); kept_moved=True
        else: kip+=1
        for x in info:
            if x is keep: continue
            quar.append((x,tgt,keep))
    tot=kip+len(moves)+len(quar)+sum(len(a) for a in amb)
    print("##### %s #####"%root)
    print("  files=%d keep=%d move=%d quarantine=%d ambiguous=%d  INVARIANT %s"%(
        len(rels),kip,len(moves),len(quar),sum(len(a) for a in amb),
        "OK" if len(rels)==tot else "MISMATCH %d!=%d"%(len(rels),tot)))
    # moves grouped by source-dir -> dest-dir
    md=defaultdict(int)
    for s,t in moves:
        sd=s.rsplit("/",1)[0] if "/" in s else ""
        td=t.rsplit("/",1)[0] if "/" in t else ""
        md[(sd,td)]+=1
    if md:
        print("  -- folder recasing/relocation (src -> dst : #files) --")
        for (sd,td),n in sorted(md.items(),key=lambda x:-x[1]):
            print("     %3d  %s\n          -> %s"%(n,sd,td))
    if quar:
        print("  -- QUARANTINE duplicates (drop -> keep) --")
        for x,tgt,k in sorted(quar,key=lambda z:z[0][0]):
            print("     DROP %s (%dk %.0fs)  keep-> %s (%dk %.0fs)"%(x[0],x[4]//1000,x[3],tgt,k[4]//1000,k[3]))
    if amb:
        print("  -- AMBIGUOUS different-length, KEPT BOTH --")
        for a in amb:
            for x in a: print("     ? %s (%dk %.0fs)"%(x[0],x[4]//1000,x[3]))
    print()

for d in ["Music","media","Videos","Documents"]:
    p="/home/pippijn/"+d
    if os.path.isdir(p): plan_for(p)
