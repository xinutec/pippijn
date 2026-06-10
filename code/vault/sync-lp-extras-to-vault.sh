#!/usr/bin/env nix-shell
#!nix-shell -i bash -p bitwarden-cli lastpass-cli python3
# Carry the NON-login items that exist in LastPass but not Vaultwarden into
# Vaultwarden as native Bitwarden item types:
#   LastPass "Credit Card" note  -> bw card item     (type 3)
#   LastPass "Address" note      -> bw identity item (type 4)
#   blank-URL login (e.g. Signal)-> bw login item    (type 1)
#
# The logins-only reconcile (reconcile-vault-lastpass.sh) matches on
# URL+username and therefore skips cards, identities, and URL-less logins.
# This closes that remaining gap so the two vaults are fully in sync.
#
# DELIBERATELY EXCLUDED: the "Fleet recovery - restic passwords" secure note
# stays LastPass-only — Vaultwarden runs ON the fleet, so fleet-recovery
# secrets must not live inside it. Already-present items (matched by name)
# are skipped, so re-running is safe.
#
#   ./sync-lp-extras-to-vault.sh           # DRY RUN (redacted preview)
#   ./sync-lp-extras-to-vault.sh --apply
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1

[ -f "$HOME/.config/bw-session" ] || { echo "no Vaultwarden session — run vault-session.sh"; exit 1; }
export BW_SESSION="$(cat "$HOME/.config/bw-session")"
export BITWARDENCLI_APPDATA_DIR="$HOME/.config/bw-cli"
lpass status -q 2>/dev/null || { echo "no LastPass session — run lpass-session.sh"; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
bw sync --session "$BW_SESSION" >/dev/null 2>&1 || true
bw list items --session "$BW_SESSION" > "$WORK/vw.json" 2>/dev/null
lpass export --sync=now > "$WORK/lp.csv" 2>/dev/null

# Snapshot VW before mutation
if [ "$APPLY" = "1" ] && [ -d /Volumes/Backup ]; then
  SNAP="/Volumes/Backup/.vault-snapshots"; mkdir -p "$SNAP"; chmod 700 "$SNAP"
  cp "$WORK/vw.json" "$SNAP/vaultwarden-$(date +%Y%m%d-%H%M%S)-pre-extras.json"
  echo "snapshot saved to $SNAP"
fi

python3 - "$WORK/vw.json" "$WORK/lp.csv" "$WORK/plan.json" <<'PY'
import csv, json, sys

vw = json.load(open(sys.argv[1]))
lp = list(csv.DictReader(open(sys.argv[2], newline="", encoding="utf-8", errors="replace")))

from urllib.parse import urlparse
def nh(u):
    u = (u or "").strip()
    if not u: return ""
    if u.startswith(("android://","androidapp://")):
        return "app:" + u.split("://",1)[1].split("@",1)[-1].rstrip("/").lower()
    if "://" not in u: u = "https://" + u
    return urlparse(u).netloc.lower().removeprefix("www.")

# existing VW item names (lowercased) per type, to skip already-present
vw_names = {1:set(), 2:set(), 3:set(), 4:set()}
vw_hostuser = set()      # logins are deduped by (host,user), like the reconcile
for it in vw:
    vw_names.setdefault(it.get("type"), set()).add((it.get("name") or "").strip().lower())
    if it.get("type") == 1:
        l = it.get("login") or {}
        user = (l.get("username") or "").strip().lower()
        for u in (l.get("uris") or []):
            vw_hostuser.add((nh(u.get("uri") or ""), user))

MONTHS = {m.lower():str(i) for i,m in enumerate(
    ["January","February","March","April","May","June","July","August",
     "September","October","November","December"], 1)}

def parse_extra(extra):
    d = {}
    for line in (extra or "").splitlines():
        if ":" in line:
            k,v = line.split(":",1); d[k.strip()] = v.strip()
    return d

# Disaster-recovery BOOTSTRAP secrets stay LastPass-only (LP is outside the
# fleet; Vaultwarden runs ON the fleet and odin backs it up, so these must not
# be reachable from a single VW compromise). Same rationale across all types.
EXCLUDE = {"fleet recovery - restic passwords", "backup disk"}
plan = []
for r in lp:
    name = (r.get("name") or "").strip()
    url = (r.get("url") or "").strip()
    extra = r.get("extra") or ""
    d = parse_extra(extra)
    nt = d.get("NoteType","")
    low = name.lower()
    if low in EXCLUDE: continue

    if nt == "Credit Card":
        if low in vw_names[3]: continue              # already a VW card
        exp = d.get("Expiration Date","")            # "July,2026" / "June,null"
        mon, _, yr = exp.partition(",")
        plan.append({"type":3,"name":name,"card":{
            "cardholderName": d.get("Name on Card","") or None,
            "brand": d.get("Type","") or None,
            "number": d.get("Number","") or None,
            "expMonth": MONTHS.get(mon.strip().lower(),""),
            "expYear": (yr.strip() if yr.strip().isdigit() else ""),
            "code": d.get("Security Code","") or None,
        }, "notes": d.get("Notes","") or None})

    elif nt == "Address":
        if low in vw_names[4]: continue              # already a VW identity
        plan.append({"type":4,"name":name,"identity":{
            "title": d.get("Title","") or None,
            "firstName": d.get("First Name","") or None,
            "middleName": d.get("Middle Name","") or None,
            "lastName": d.get("Last Name","") or None,
            "company": d.get("Company","") or None,
            "address1": d.get("Address #","") or d.get("Address","") or None,
            "city": d.get("City / Town","") or d.get("City","") or None,
            "state": d.get("County","") or d.get("State","") or None,
            "postalCode": d.get("Zip / Postal Code","") or d.get("Zip","") or None,
            "country": d.get("Country","") or None,
            "email": d.get("Email Address","") or None,
            "phone": d.get("Phone","") or d.get("Mobile Phone","") or None,
            "username": d.get("Username","") or None,
        }, "notes": None})

    elif nt in ("", None) and url == "http://sn":
        # plain LastPass secure note with no special type
        if low in EXCLUDE: continue
        if low in vw_names[2]: continue
        # skip empties
        if not extra.strip(): continue
        plan.append({"type":2,"name":name,"notes":extra,"secureNote":{"type":0}})

    else:
        # real login (has password). Dedup by (host,user) exactly like the
        # reconcile — a same-site/same-user entry with a DIFFERENT password is
        # already represented (a conflicting-password review item, not a new
        # entry), so don't duplicate it. URL-less + user-less logins (host and
        # user both empty, e.g. Signal) can't be keyed, so fall back to name.
        pw = r.get("password") or ""
        user = (r.get("username") or "").strip()
        if not pw: continue
        host = nh(url)
        if host or user.lower():
            if (host, user.lower()) in vw_hostuser: continue
        else:
            if low in vw_names[1]: continue       # name-only fallback
        uris = [{"match":None,"uri":url}] if url and url!="http://sn" else []
        plan.append({"type":1,"name":name,"login":{
            "username": user or None, "password": pw, "uris": uris}})

json.dump(plan, open(sys.argv[3],"w"))

def red(s):
    s = s or ""
    return ("#"*len(s)) if s else ""
print(f"=== plan: {len(plan)} item(s) to create in Vaultwarden ===")
for p in plan:
    t = {1:"login",2:"note",3:"card",4:"identity"}[p["type"]]
    if p["type"]==3:
        c=p["card"]; print(f"  card     {p['name']:24} {c.get('brand')}  ****{(c.get('number') or '')[-4:]}  exp {c.get('expMonth')}/{c.get('expYear')}")
    elif p["type"]==4:
        i=p["identity"]; print(f"  identity {p['name']:24} {i.get('firstName')} {i.get('lastName')}  {i.get('city') or ''} {i.get('postalCode') or ''}")
    elif p["type"]==1:
        print(f"  login    {p['name']:24} user={p['login'].get('username')}")
    else:
        print(f"  note     {p['name']:24}")
PY

COUNT=$(python3 -c "import json;print(len(json.load(open('$WORK/plan.json'))))")
if [ "$APPLY" = "0" ]; then
  echo; echo "DRY RUN — nothing created. Re-run with --apply."
  exit 0
fi
[ "$COUNT" = "0" ] && { echo "nothing to create."; exit 0; }

echo "— creating $COUNT item(s) —"
python3 -c "import json;[print(json.dumps(x)) for x in json.load(open('$WORK/plan.json'))]" | \
while IFS= read -r item; do
  nm=$(printf '%s' "$item" | python3 -c "import sys,json;print(json.load(sys.stdin).get('name'))")
  printf '%s' "$item" | bw encode | bw create item --session "$BW_SESSION" >/dev/null \
    && echo "  created: $nm" || echo "  FAILED:  $nm"
done
bw sync --session "$BW_SESSION" >/dev/null 2>&1 || true
echo "done."
