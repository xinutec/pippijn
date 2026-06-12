import os, sys, subprocess, shutil
sys.stdout.reconfigure(errors="replace")
from collections import defaultdict
APPLY = "--apply" in sys.argv
QROOT = "/home/pippijn/quarantine"
HOME = "/home/pippijn"

def probe(path):
    try:
        o=subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration,bit_rate",
          "-of","default=noprint_wrappers=1:nokey=1",path],stderr=subprocess.DEVNULL).decode("utf-8","replace").split()
        return (float(o[0]) if o and o[0] not in("N/A","") else 0.0, int(o[1]) if len(o)>1 and o[1] not in("N/A","") else 0)
    except Exception: return 0.0,0
def sz(p):
    try: return os.path.getsize(p)
    except Exception: return 0

def run(root):
    rels=[]
    for dp,dn,fns in os.walk(root):
        for fn in fns: rels.append(os.path.relpath(os.path.join(dp,fn),root))
    cnt=defaultdict(int)
    for r in rels:
        p=r.split("/")
        for i in range(1,len(p)): cnt["/".join(p[:i])]+=1
    canon={"":""}; bd=defaultdict(list)
    for d in cnt: bd[d.count("/")].append(d)
    for depth in sorted(bd):
        g=defaultdict(list)
        for d in bd[depth]:
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
    quar=[]; moves=[]; amb=0
    for (cd,lfn),mem in fg.items():
        if len(mem)==1:
            r,fn,d=mem[0]; tgt=(cd+"/"+fn) if cd else fn
            if r!=tgt: moves.append((r,tgt))
            continue
        info=[(r,fn,d,*probe(os.path.join(root,r)),sz(os.path.join(root,r))) for r,fn,d in mem]
        durs=[x[3] for x in info]
        if max(durs)-min(durs)>10.0: amb+=len(info); continue
        keep=max(info,key=lambda x:(x[4],x[5]))
        tgt=(cd+"/"+keep[1]) if cd else keep[1]
        if keep[0]!=tgt: moves.append((keep[0],tgt))
        for x in info:
            if x is keep: continue
            quar.append(x[0])
    rname=os.path.relpath(root,HOME)
    print("%s: quarantine=%d moves=%d ambiguous=%d"%(rname,len(quar),len(moves),amb))
    if not APPLY: return
    # 1. quarantine drops FIRST (vacate canonical paths)
    for rel in quar:
        src=os.path.join(root,rel); dst=os.path.join(QROOT,rname,rel)
        os.makedirs(os.path.dirname(dst),exist_ok=True); shutil.move(src,dst)
    # 2. moves to canonical (now vacant)
    skipped=0
    for s,t in moves:
        src=os.path.join(root,s); dst=os.path.join(root,t)
        os.makedirs(os.path.dirname(dst),exist_ok=True)
        if os.path.exists(dst): print("  SKIP (dst exists):",t); skipped+=1; continue
        shutil.move(src,dst)
    # 3. remove empty dirs
    removed=0
    for dp,dn,fns in os.walk(root,topdown=False):
        if dp!=root and not os.listdir(dp):
            os.rmdir(dp); removed+=1
    print("  applied: quarantined=%d moved=%d skipped=%d empty_dirs_removed=%d"%(len(quar),len(moves)-skipped,skipped,removed))

for d in ["Music","media"]:
    run(os.path.join(HOME,d))
