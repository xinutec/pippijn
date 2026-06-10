#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p python3
"""Clean a Google Password Manager CSV export for Vaultwarden import.

- Drops EXACT duplicate rows (same url+username+password) — pure dupes.
- Keeps both rows when the same site+username has DIFFERENT passwords
  (we cannot know which is current; resolve in the vault UI later).
- Keeps blank-password rows (site/username records are still useful),
  but lists them on stderr for review.

Usage: clean-google-csv.py <google-export.csv> <cleaned.csv>
"""
from __future__ import annotations

import csv
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]

    with open(src, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames or []
        rows = list(reader)

    seen: set[tuple[str, str, str]] = set()
    kept: list[dict[str, str]] = []
    exact_dupes = 0
    conflicts = 0
    blanks: list[str] = []
    pair_seen: set[tuple[str, str]] = set()

    for r in rows:
        url = (r.get("url") or "").strip()
        user = (r.get("username") or "").strip()
        pw = (r.get("password") or "").strip()
        key = (url, user, pw)
        if key in seen:
            exact_dupes += 1
            continue
        if (url, user) in pair_seen:
            conflicts += 1  # same site+user, different password — keep both
        seen.add(key)
        pair_seen.add((url, user))
        if not pw:
            blanks.append(f"{r.get('name', '')} ({user})")
        kept.append(r)

    with open(dst, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(kept)

    print(f"in: {len(rows)}  kept: {len(kept)}  exact-dupes dropped: {exact_dupes}")
    print(f"same site+user, different password (kept both): {conflicts}")
    print(f"blank-password entries (kept, review later): {len(blanks)}", file=sys.stderr)
    for b in blanks:
        print(f"  - {b}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
