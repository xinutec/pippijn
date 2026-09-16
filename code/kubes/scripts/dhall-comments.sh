#!/usr/bin/env bash
# Refuse a commit that strips a Dhall file's comments.
#
# `dhall format` DELETES most comments. It keeps only those sitting after a token
# that opens an expression — the top of a file, after a `let`'s `=`, and inside a
# record before a field name — and discards everything else, including the `--|`
# doc blocks above `let` bindings that carry this model's reasoning.
#
# ⚠ NOTHING ELSE CAN SEE THIS HAPPEN. Comments never reach the rendered YAML, so
# `generate.sh --check` stays green, every test stays green, and a formatter that
# ate two thirds of a file is found by eye or not at all.
#
# The threshold is ANY DROP. A percentage bar has to be sized to the hazard, and
# the hazard shrank once doc blocks moved below their `let`'s `=` — a guard sized
# to a hazard that no longer exists is not a guard. See `LOSS_PCT`.
#
# ⚠ This does not make the tree safe to format. It costs 4% now rather than 46%,
# but a comment trailing a field or inside a `<A | B>` union has no surviving
# position at all, so the rule remains "do not run dhall format here". This is
# the net under it.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

readonly TREE="code/kubes/dhall"
# ANY drop, not a percentage: a percentage bar is sized to whatever the formatter
# costs TODAY, and that number moves. Cheap, because a deliberate cull reaching
# for DHALL_COMMENTS_OK is rare rather than routine.
readonly LOSS_PCT=0

comments() { grep -cE '^[[:space:]]*(--|\{-)' || true; }

status=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  # A file being added has no previous version to lose anything against.
  git cat-file -e "HEAD:$file" 2>/dev/null || continue

  before=$(git show "HEAD:$file" | comments)
  after=$(comments < "$file")
  [ "$before" -gt 0 ] || continue
  [ "$after" -lt "$before" ] || continue

  lost=$((before - after))
  pct=$((lost * 100 / before))
  if [ "$pct" -ge "$LOSS_PCT" ]; then  # LOSS_PCT=0, so: any drop at all
    echo "$file: $before comment lines -> $after, ${pct}% gone" >&2
    status=1
  fi
done < <(git diff --name-only HEAD -- "$TREE" | grep '\.dhall$' || true)

if [ "$status" -ne 0 ]; then
  cat >&2 <<'WHY'

A Dhall file lost comments. If `dhall format` ran here, revert it: the
reasoning in this model is the part that does not survive, and no other check can
see it go. Recover with the three-way merge in de509130 if it is already
committed.

If the removal is deliberate, say so in the commit and re-run with
DHALL_COMMENTS_OK=1.
WHY
  [ -n "${DHALL_COMMENTS_OK:-}" ] && exit 0
  exit 1
fi
echo "dhall comments: no file lost any"
