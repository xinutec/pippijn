#!/usr/bin/env nix-shell
#!nix-shell -i bash -p bitwarden-cli lastpass-cli python3
# Keep LastPass in sync with Vaultwarden while you clean up passwords.
# Vaultwarden is the master (you do the work there; bw writes cleanly).
# LastPass follows. Based on what the lpass CLI can ACTUALLY do safely on
# this account (established 2026-06-11):
#
#   * lpass READS work; lpass `import` reaches the server reliably.
#   * lpass incremental writes (add/edit/rm) CORRUPT the local vault blob,
#     and `lpass sync` runs away — so we NEVER use them.
#
# Therefore:
#   ADDS  (in VW, not LP)  -> applied automatically via `lpass import`.
#   DELETES (in LP, not VW)-> emitted as a precise list you action in the
#                             LastPass WEB VAULT (the only reliable delete).
#
# IMPORTANT: the lpass local cache goes STALE after server changes. Re-run
# lpass-session.sh (fresh login) right before using this, so LP state is
# accurate and adds aren't re-imported as duplicates.
#
#   ./sync-vw-to-lastpass.sh                # DRY RUN: show counts, write artifacts
#   ./sync-vw-to-lastpass.sh --import-adds  # also auto-import the adds into LP
#
# Artifacts (under ~/.cache/vault-sync/):
#   lp-add.csv     entries to add  (auto-imported with --import-adds, or
#                  import yourself in the LastPass web vault)
#   lp-delete.txt  entries to DELETE in the LastPass web vault, by hand
set -euo pipefail
IMPORT_ADDS=0; [ "${1:-}" = "--import-adds" ] && IMPORT_ADDS=1
VW_FLOOR="${VW_FLOOR:-500}"

[ -f "$HOME/.config/bw-session" ] || { echo "no Vaultwarden session — run vault-session.sh"; exit 1; }
export BW_SESSION="$(cat "$HOME/.config/bw-session")"
export BITWARDENCLI_APPDATA_DIR="$HOME/.config/bw-cli"
lpass status -q 2>/dev/null || { echo "no LastPass session — run lpass-session.sh"; exit 1; }
if pgrep -f 'lpass (sync|edit|rm|add|import)' >/dev/null 2>&1; then
  echo "ABORT: another lpass write/sync is running. Wait, then retry."; exit 4
fi

OUT="$HOME/.cache/vault-sync"; mkdir -p "$OUT"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
bw sync --session "$BW_SESSION" >/dev/null 2>&1 || true
bw list items --session "$BW_SESSION" > "$WORK/vw.json" 2>/dev/null
lpass export > "$WORK/lp.csv" 2>/dev/null      # NO --sync (avoids runaway); relies on fresh login

python3 - "$WORK/vw.json" "$WORK/lp.csv" "$OUT/lp-add.csv" "$OUT/lp-delete.txt" "$VW_FLOOR" <<'PY'
import csv, json, sys
from urllib.parse import urlparse

vw = json.load(open(sys.argv[1]))
lp = list(csv.DictReader(open(sys.argv[2], newline="", encoding="utf-8", errors="replace")))
VW_FLOOR = int(sys.argv[5])

def nh(u):
    u = (u or "").strip()
    if not u: return ""
    if u.startswith(("android://","androidapp://")):
        return "app:" + u.split("://",1)[1].split("@",1)[-1].rstrip("/").lower()
    if "://" not in u: u = "https://" + u
    return urlparse(u).netloc.lower().removeprefix("www.")

# recovery secrets that live in LastPass ONLY — never delete
EXCLUDE = {"fleet recovery - restic passwords", "backup disk"}

# index VW logins by (host,user); keep best (newest) for adds
vw_keys = set(); vw_best = {}
for it in vw:
    if it.get("type") != 1: continue
    l = it.get("login") or {}
    user = (l.get("username") or "").strip().lower()
    uris = [(u.get("uri") or "") for u in (l.get("uris") or [])]
    keys = {(nh(u), user) for u in uris} or {("", user)}
    rev = it.get("revisionDate") or ""
    for k in keys:
        if not (k[0] or k[1]): continue
        vw_keys.add(k)
        if k not in vw_best or rev > vw_best[k][0]:
            vw_best[k] = (rev, {"url": next((u for u in uris if u), ""),
                                "user": l.get("username") or "", "pw": l.get("password") or "",
                                "name": it.get("name") or ""})

if len(vw_keys) < VW_FLOOR:
    print(f"ABORT: VW returned only {len(vw_keys)} login keys (< {VW_FLOOR}); refusing (bad read?).")
    sys.exit(3)

# index LP logins by (host,user)
lp_keys = set(); lp_rows = []
for r in lp:
    url = (r.get("url") or "").strip()
    if url == "http://sn":        # secure note / card / identity — never touch
        continue
    name = (r.get("name") or "").strip()
    user = (r.get("username") or "").strip()
    host = nh(url); ul = user.lower()
    if not (host or ul): continue
    key = (host, ul)
    lp_keys.add(key)
    lp_rows.append((key, name, url, user))

# ADDS: VW keys not in LP
adds = [vw_best[k][1] for k in (vw_keys - lp_keys)]
# DELETES: LP keys not in VW (what you removed from VW) — minus protected
seen = set(); deletes = []
for key, name, url, user in lp_rows:
    if name.strip().lower() in EXCLUDE: continue
    if key in vw_keys: continue
    if key in seen: continue
    seen.add(key)
    deletes.append((name, url, user))

with open(sys.argv[3], "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["url","username","password","extra","name","grouping","fav"])
    w.writeheader()
    for a in adds:
        w.writerow({"url": a["url"] or "http://sn", "username": a["user"], "password": a["pw"],
                    "extra": "", "name": a["name"], "grouping": "Imported/Vaultwarden", "fav": 0})

with open(sys.argv[4], "w") as f:
    f.write(f"# Delete these {len(deletes)} entries in the LastPass web vault "
            f"(https://lastpass.com/vault/) — they were removed from Vaultwarden.\n")
    f.write("# name\turl\tusername\n")
    for name, url, user in sorted(deletes):
        f.write(f"{name}\t{url}\t{user}\n")

print(f"VW login keys: {len(vw_keys)}   LP login keys: {len(lp_keys)}")
print(f"  ADD to LastPass    (in VW, not LP): {len(adds)}")
print(f"  DELETE from LastPass (in LP, not VW): {len(deletes)}  (recovery secrets protected)")
for name, url, user in sorted(deletes)[:30]:
    print(f"     delete: {name}  ({url}  {user})")
PY

RC=$?
[ $RC -ne 0 ] && exit $RC
echo
echo "artifacts:"
echo "  adds   -> $OUT/lp-add.csv     ($(($(wc -l < "$OUT/lp-add.csv")-1)) entries)"
echo "  deletes-> $OUT/lp-delete.txt  (action in the LastPass web vault)"

if [ "$IMPORT_ADDS" = "1" ]; then
  ADDN=$(($(wc -l < "$OUT/lp-add.csv")-1))
  if [ "$ADDN" -gt 0 ]; then
    echo "— importing $ADDN adds into LastPass —"
    lpass import "$OUT/lp-add.csv" 2>&1 | grep -vE "Deprecation|trace-dep" | tail -2
    echo "(LastPass server updated; local lpass cache is now stale — re-login to refresh reads)"
  else echo "no adds to import."; fi
else
  echo
  echo "DRY RUN. Re-run with --import-adds to push the adds. Deletes are always manual (web vault)."
fi