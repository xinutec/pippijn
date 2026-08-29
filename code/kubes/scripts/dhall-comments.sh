#!/usr/bin/env bash
# Refuse a commit that strips a Dhall file's comments.
#
# `dhall format` DELETES most comments. It keeps only those sitting after a token
# that opens an expression — the top of a file, after a `let`'s `=`, and inside a
# record before a field name — and discards everything else, including the `--|`
# doc blocks above `let` bindings that carry this model's reasoning.
#
# It has fired once. 8bb958ea ("kubes: reach belongs to a workload, not a
# namespace", 2026-08-13) is a semantic change whose diff also took types.dhall
# from 313 comment lines to 42 and render.dhall from 217 to 79. Nothing caught
# it: comments never reach the rendered YAML, so `generate.sh --check` was green,
# every test was green, and the loss was found by eye. de509130 restored it from
# a three-way merge the same day.
#
# The threshold is ANY DROP, and it got there by being wrong once. It started at
# 50%, which was measured: across all 118 commits touching `code/kubes/dhall`,
# deliberate culls lose at most 15% of a file (34906949, 8%) while the formatter
# took 87%, 64% and 57% of three files in one commit, so 50% separated them with
# nothing in between. Then dcc155ec moved every doc block below its `let`'s `=`
# and the hazard fell from 46% of the tree to 4% — which sails under a 50% bar. A
# guard sized to a hazard that has since shrunk is not a guard. See `LOSS_PCT`.
#
# ⚠ This does not make the tree safe to format. It costs 4% now rather than 46%,
# but a comment trailing a field or inside a `<A | B>` union has no surviving
# position at all, so the rule remains "do not run dhall format here". This is
# the net under it.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

readonly TREE="code/kubes/dhall"
# ANY drop, not a percentage. The threshold was 50% when the hazard was 46% —
# formatting the tree cost 1292 of 2824 comment lines. dcc155ec moved every doc
# block below its `let`'s `=`, so a format now costs 115 lines (4%), which sailed
# under a 50% bar. A guard sized to the old hazard is not a guard.
#
# Cheap, measured: across all 118 commits touching this tree only 12 dropped a
# file's comment count at all, so a deliberate cull reaching for
# DHALL_COMMENTS_OK is rare rather than routine.
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
