#!/usr/bin/env nix-shell
#!nix-shell -i bash -p bitwarden-cli lastpass-cli python3
# Two-way reconcile between the self-hosted Vaultwarden vault and LastPass.
#
# Each side gains the LOGIN entries the other has and it lacks, matched by
# (host, username). It is ADD-ONLY: an existing entry on either side is
# never modified or deleted — so neither vault can clobber the other, and
# re-running is safe (already-present entries are skipped).
#
# Prereqs (both unlocked, no master password seen here):
#   ! /Users/pippijn/Code/pippijn/code/vault/vault-session.sh   # Vaultwarden
#   ! /Users/pippijn/Code/pippijn/code/vault/lpass-session.sh    # LastPass
#
#   ./reconcile-vault-lastpass.sh           # DRY RUN — counts + samples only
#   ./reconcile-vault-lastpass.sh --apply   # actually import both directions
#
# Before --apply, a full plaintext snapshot of BOTH vaults is written to the
# FileVault-encrypted Backup drive so the merge is reversible.
set -euo pipefail

APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1

# --- sessions -------------------------------------------------------------
[ -f "$HOME/.config/bw-session" ] || { echo "no Vaultwarden session — run vault-session.sh first"; exit 1; }
export BW_SESSION="$(cat "$HOME/.config/bw-session")"
export BITWARDENCLI_APPDATA_DIR="$HOME/.config/bw-cli"
bw config server https://vault.xinutec.org >/dev/null 2>&1 || true
lpass status -q 2>/dev/null || { echo "no LastPass session — run lpass-session.sh first"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "— exporting both vaults —"
bw sync --session "$BW_SESSION" >/dev/null 2>&1 || true
bw list items --session "$BW_SESSION" > "$WORK/vw.json"
lpass export --sync=now > "$WORK/lp.csv" 2>/dev/null

# --- snapshot before any mutation ----------------------------------------
if [ "$APPLY" = "1" ]; then
  SNAP="/Volumes/Backup/.vault-snapshots"
  if [ -d /Volumes/Backup ]; then
    mkdir -p "$SNAP"; chmod 700 "$SNAP"
    TS="$(date +%Y%m%d-%H%M%S)"
    cp "$WORK/vw.json" "$SNAP/vaultwarden-$TS.json"
    cp "$WORK/lp.csv"  "$SNAP/lastpass-$TS.csv"
    chmod 600 "$SNAP"/vaultwarden-"$TS".json "$SNAP"/lastpass-"$TS".csv
    echo "snapshot saved to $SNAP (encrypted drive)"
  else
    echo "WARNING: /Volumes/Backup not mounted — proceeding WITHOUT a snapshot"
  fi
fi

# --- diff -----------------------------------------------------------------
python3 - "$WORK/vw.json" "$WORK/lp.csv" "$WORK/to_lastpass.csv" "$WORK/to_vaultwarden.csv" <<'PY'
import csv, json, sys
from urllib.parse import urlparse

vw_path, lp_path, to_lp, to_vw = sys.argv[1:5]

def norm_host(u: str) -> str:
    u = (u or "").strip()
    if not u:
        return ""
    if u.startswith(("android://", "androidapp://")):
        body = u.split("://", 1)[1]
        return "app:" + body.split("@", 1)[-1].rstrip("/").lower()
    if "://" not in u:
        u = "https://" + u
    return urlparse(u).netloc.lower().removeprefix("www.")

# --- Vaultwarden: login items only ---
vw = json.load(open(vw_path))
vw_logins = []           # (keys:set, uri, user, pw, name, totp, notes)
vw_keys = set()
for it in vw:
    if it.get("type") != 1:        # 1 = login
        continue
    login = it.get("login") or {}
    user = (login.get("username") or "").strip()
    uris = [ (u.get("uri") or "") for u in (login.get("uris") or []) ]
    keys = {(norm_host(u), user.lower()) for u in uris} or {("", user.lower())}
    vw_keys |= keys
    vw_logins.append({
        "keys": keys,
        "uri": next((u for u in uris if u), ""),
        "user": user,
        "pw": login.get("password") or "",
        "name": it.get("name") or "",
        "totp": login.get("totp") or "",
        "notes": it.get("notes") or "",
    })

# --- LastPass: CSV rows ---
lp_rows = list(csv.DictReader(open(lp_path, newline="", encoding="utf-8", errors="replace")))
def g(r, *names):
    for n in names:
        if n in r and r[n] is not None:
            return r[n]
    return ""
lp_keys = set()
lp_norm = []
for r in lp_rows:
    url = g(r, "url"); user = g(r, "username")
    # skip LastPass secure notes / app records with no real login
    key = (norm_host(url), user.strip().lower())
    lp_keys.add(key)
    lp_norm.append((key, r))

# --- compute the two add-only deltas ---
vw_only = [v for v in vw_logins if not (v["keys"] & lp_keys)]
lp_only = [r for (k, r) in lp_norm if k not in vw_keys
           and (k[0] or k[1])                       # has host or user
           and (g(r, "password") or g(r, "username"))]  # is a real login

# de-dupe within each delta by (host,user,password)
def dedupe(rows, keyf):
    seen=set(); out=[]
    for x in rows:
        k=keyf(x)
        if k in seen: continue
        seen.add(k); out.append(x)
    return out
vw_only = dedupe(vw_only, lambda v:(sorted(v["keys"])[0], v["pw"]))
lp_only = dedupe(lp_only, lambda r:((norm_host(g(r,"url")), g(r,"username").lower()), g(r,"password")))

LP_COLS = ["url","username","password","extra","name","grouping","totp","fav"]

# VW-only -> LastPass-format CSV (for `lpass import`)
with open(to_lp, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=LP_COLS); w.writeheader()
    for v in vw_only:
        w.writerow({"url": v["uri"] or "http://sn", "username": v["user"],
                    "password": v["pw"], "extra": v["notes"], "name": v["name"],
                    "grouping": "Imported/Vaultwarden", "totp": v["totp"], "fav": 0})

# LP-only -> LastPass-format CSV (for `bw import lastpasscsv`)
with open(to_vw, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=LP_COLS); w.writeheader()
    for r in lp_only:
        w.writerow({"url": g(r,"url"), "username": g(r,"username"),
                    "password": g(r,"password"), "extra": g(r,"extra","notes"),
                    "name": g(r,"name"), "grouping": "Imported/LastPass",
                    "totp": g(r,"totp"), "fav": 0})

print(f"Vaultwarden logins: {len(vw_logins)}   LastPass rows: {len(lp_rows)}")
print(f"  -> to add to LastPass    (in VW, not LP): {len(vw_only)}")
print(f"  -> to add to Vaultwarden (in LP, not VW): {len(lp_only)}")
print("  sample VW->LP:", "; ".join(sorted({sorted(v['keys'])[0][0] for v in vw_only if sorted(v['keys'])[0][0]})[:6]))
print("  sample LP->VW:", "; ".join(sorted({norm_host(g(r,'url')) for r in lp_only if norm_host(g(r,'url'))})[:6]))
PY

if [ "$APPLY" = "0" ]; then
  echo
  echo "DRY RUN — nothing changed. Re-run with --apply to import both directions."
  exit 0
fi

echo "— importing VW-only into LastPass —"
lpass import "$WORK/to_lastpass.csv" 2>&1 | tail -3 || true
lpass sync >/dev/null 2>&1 || true

echo "— importing LP-only into Vaultwarden —"
bw import lastpasscsv "$WORK/to_vaultwarden.csv" --session "$BW_SESSION" 2>&1 | tail -3 || true
bw sync --session "$BW_SESSION" >/dev/null 2>&1 || true

echo "done. Re-run without --apply to confirm both deltas are now 0."
