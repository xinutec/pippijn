#!/usr/bin/env bash
# Render the typed fleet model into Kubernetes manifests.
#
#   ./generate.sh              write manifests to dhall/generated/<app>/
#   ./generate.sh --check      diff the model against the live <app>/k8s/ tree,
#                              exit 1 if they describe different clusters
#
# Rendering is pure evaluation — Dhall cannot perform IO — so --check is a
# genuine dry run rather than a mode the renderer has to remember to honour.
#
# --check compares the app's whole manifest *set*, not file by file: today the
# live tree numbers the same resources differently per app (home/05-ingress.yaml
# vs life/04-ingress.yaml), and the question worth answering is whether the model
# describes the same cluster state, not whether it picked the same filenames.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
kubes=$(cd "$here/.." && pwd)

# Toolchain pinned via dhall/flake.lock. The guard stops a re-exec loop if the
# dev shell somehow still lacks the tool.
if ! command -v dhall-to-yaml-ng >/dev/null 2>&1; then
  if [[ -n ${FLEET_DHALL_REEXEC:-} ]]; then
    echo "error: dhall-to-yaml-ng missing inside the dev shell" >&2
    exit 1
  fi
  export FLEET_DHALL_REEXEC=1
  exec nix develop "$here" --command "${BASH_SOURCE[0]}" "$@"
fi

mode=write
case ${1:-} in
  --check) mode=check ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

# Output file -> the renderers whose documents it concatenates.
manifests=(
  "00-namespace.yaml:namespace"
  "01-pvc.yaml:pvc"
  "02-db.yaml:dbDeployment dbService"
  "03-app.yaml:appDeployment appService"
  "04-ingress.yaml:ingress"
  "05-networkpolicy.yaml:netpolDb"
  "06-networkpolicy-app-held.yaml:netpolAppHeld"
)

render() { # app renderer -> YAML documents (nothing if the renderer opts out)
  local out
  out=$(printf 'let R = %s/lib/render.dhall in R.%s %s/apps/%s.dhall\n' \
    "$here" "$2" "$here" "$1" |
    dhall-to-yaml-ng --omit-empty --documents)
  # A renderer that does not apply returns an empty list, which --omit-empty
  # serialises as one null document. That means "no file", not "a file
  # containing null".
  [[ $out == "---"$'\n'"null" ]] && return 0
  printf '%s' "$out"
}

header() {
  printf '# GENERATED from dhall/apps/%s.dhall by dhall/generate.sh — do not edit.\n' "$1"
  printf '# Change the model and re-render; hand edits are overwritten.\n'
}

status=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for src in "$here"/apps/*.dhall; do
  app=$(basename "$src" .dhall)
  outdir="$here/generated/$app"
  [[ $mode == write ]] && { rm -rf "$outdir"; mkdir -p "$outdir"; }
  : > "$tmp/$app.model.yaml"

  for entry in "${manifests[@]}"; do
    file=${entry%%:*}
    body=""
    for r in ${entry#*:}; do
      body+=$(render "$app" "$r")
      body+=$'\n'
    done
    [[ -z ${body//[$'\n']/} ]] && continue

    printf '%s' "$body" >> "$tmp/$app.model.yaml"
    printf '\n' >> "$tmp/$app.model.yaml"

    [[ $mode == write ]] && { header "$app"; printf '%s' "$body"; } > "$outdir/$file"
  done

  if [[ $mode == check ]]; then
    # Each file needs its own document separator, or two files concatenate into
    # one malformed document and the diff becomes nonsense.
    : > "$tmp/$app.live.yaml"
    for f in "$kubes/$app"/k8s/*.yaml; do
      { printf -- '---\n'; cat "$f"; printf '\n'; } >> "$tmp/$app.live.yaml"
    done
    if ! diff -u \
           <(python3 "$here/normalize.py" < "$tmp/$app.live.yaml") \
           <(python3 "$here/normalize.py" < "$tmp/$app.model.yaml") \
           > "$tmp/$app.diff"; then
      echo "===== $app: live tree → model"
      tail -n +3 "$tmp/$app.diff"
      echo
      status=1
    else
      echo "===== $app: model matches the live tree"
    fi
  fi
done

[[ $mode == write ]] && echo "rendered to $here/generated/"
exit $status
