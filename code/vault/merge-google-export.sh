#!/usr/bin/env nix-shell
#!nix-shell -i bash -p bitwarden-cli python3
# Merge a fresh Google Password Manager CSV export into Vaultwarden.
#
# Google has NO password API, so the flow is: you click Export at
# https://passwords.google.com (Settings -> Export passwords), then run
# this on the downloaded CSV. Everything after the click is automated:
#
#   - entries NEW to the vault (no login item with same URL+username)
#     are imported;
#   - entries already in the vault are left alone (the vault is the
#     source of truth — a stale Google password never overwrites it);
#   - nothing is ever deleted;
#   - the CSV is securely deleted afterwards (prompted).
#
# Usage: ./merge-google-export.sh ~/Downloads/Google\ Passwords.csv
set -euo pipefail

CSV="${1:?usage: $0 <google-export.csv>}"
[ -f "$CSV" ] || { echo "no such file: $CSV"; exit 1; }

export BITWARDENCLI_APPDATA_DIR="$(mktemp -d)"
WORK="$(mktemp -d)"
trap 'bw logout >/dev/null 2>&1 || true; rm -rf "$BITWARDENCLI_APPDATA_DIR" "$WORK"' EXIT

bw config server https://vault.xinutec.org >/dev/null
echo "— log in (master password) —"
bw login pip88nl@gmail.com
SESSION=$(bw unlock --raw)

echo "— diffing export against vault —"
bw list items --session "$SESSION" > "$WORK/vault.json"
python3 - "$CSV" "$WORK/vault.json" "$WORK/new.csv" <<'PY'
import csv, json, sys
from urllib.parse import urlparse

csv_path, vault_path, out_path = sys.argv[1:4]

def norm_host(u: str) -> str:
    u = (u or "").strip()
    if not u:
        return ""
    # Android app credentials: Chrome exports android://CERTHASH@package/,
    # Bitwarden stores androidapp://package — normalize both to the package
    # name or every app login looks "new" on each merge.
    if u.startswith(("android://", "androidapp://")):
        body = u.split("://", 1)[1]
        return "app:" + body.split("@", 1)[-1].rstrip("/").lower()
    if "://" not in u:
        u = "https://" + u
    return urlparse(u).netloc.lower().removeprefix("www.")

# index existing vault logins by (host, username)
have = set()
for item in json.load(open(vault_path)):
    login = item.get("login") or {}
    user = (login.get("username") or "").strip().lower()
    for uri in (login.get("uris") or []):
        have.add((norm_host(uri.get("uri") or ""), user))

rows = list(csv.DictReader(open(csv_path, newline="", encoding="utf-8", errors="replace")))
fields = rows[0].keys() if rows else ["name", "url", "username", "password", "note"]
new, skipped = [], 0
seen = set()
for r in rows:
    key = (norm_host(r.get("url") or ""), (r.get("username") or "").strip().lower())
    dedup = (key, (r.get("password") or "").strip())
    if key in have or dedup in seen:
        skipped += 1
        continue
    seen.add(dedup)
    new.append(r)

with open(out_path, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(fields))
    w.writeheader()
    w.writerows(new)
print(f"export rows: {len(rows)}  already in vault / dupes: {skipped}  NEW to import: {len(new)}")
PY

NEW_COUNT=$(($(wc -l < "$WORK/new.csv") - 1))
if [ "$NEW_COUNT" -gt 0 ]; then
  echo "— importing $NEW_COUNT new entries —"
  bw import chromecsv "$WORK/new.csv" --session "$SESSION"
else
  echo "— nothing new to import —"
fi

echo
read -r -p "delete the plaintext export ($CSV)? [Y/n] " ans
case "${ans:-Y}" in [Yy]*) rm -f "$CSV" && echo "deleted";; *) echo "KEPT — delete it yourself soon";; esac
