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
  "01-pvc.yaml:pvc appPvc"
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

doc_waiver() { # app file body -> body, with any in-document waiver injected
  # Unlike header()'s waivers, this one must sit INSIDE the document:
  # DL-DEPLOY-BACKUP-COVERAGE walks up from the document's first key and stops
  # at the leading `---`, so a line emitted above the separator is never seen.
  #
  # App-aware, unlike the 02-db.yaml waiver, and deliberately so: blanket-
  # emitting would also waive the db PVCs, which ARE backed up, and dev-lint
  # fails a waiver that waives nothing — the over-waive would surface as
  # DL-WAIVER-INEFFECTIVE on every other app instead of a clean pass here.
  case "$1:$2" in
    utterance:01-pvc.yaml)
      printf '%s' "$3" | awk '{ print } !seen && /^---$/ { print WAIVER; seen = 1 }' \
        WAIVER='# dev-lint: allow-backup-coverage utterance is under heavy development and its uploads are re-derivable; backing it up is deliberately deferred'
      ;;
    *) printf '%s' "$3" ;;
  esac
}

header() { # app file
  printf '# GENERATED from dhall/apps/%s.dhall by dhall/generate.sh — do not edit.\n' "$1"
  printf '# Change the model and re-render; hand edits are overwritten.\n'
  # Rendering drops the model's inline comments, which is fine for rationale
  # (it stays in lib/render.dhall) but NOT for a warning someone needs while
  # looking at this file on the host at 3am. Those are re-emitted here.
  case $2 in
    02-db.yaml)
      printf '#\n'
      printf '# MariaDB has NO downgrade path. Before changing the engine version\n'
      printf '# (lib/render.dhall, one line, bumps every database at once):\n'
      printf '#   scripts/mariadb-major-upgrade.sh before <app> <db>   (then after)\n'
      printf '# strategy is Recreate: a single RWO PVC must never have two DB pods.\n'
      # DL-K8S-NP-DEFAULT-DENY anchors on the first Deployment in the namespace,
      # which is this file's first document — so the waiver belongs here, above
      # the leading `---`, exactly where the hand-written life/k8s copy has it.
      # It is deliberately NOT a model field: a waiver is a fact about dev-lint,
      # not about the deployment, and the model should not learn linter concepts.
      # Blanket-emitting it is safe because dev-lint FAILS an ineffective waiver
      # ("a waiver that waives nothing is a baseline entry nobody can see"), so
      # the first app to gain a real default-deny policy fails here and this
      # line has to become app-aware at that point rather than silently over-waiving.
      printf '# dev-lint: allow-no-netpol — pre-existing: namespace needs a default-deny NetworkPolicy + allow-graph (network-hardening)\n'
      ;;
    *-held.yaml)
      # The marker string below is LOAD-BEARING, not decoration: scripts/apply.sh
      # refuses any file containing it, and fleet_health.py's drift sweep skips
      # it so a deliberately-unapplied manifest is not reported as permanent
      # drift. Both tools also skip on the *held* filename, so this is defence in
      # depth — losing either would silently arm the policy below.
      printf '#\n'
      printf '# NOT YET APPLIED. k3s enforces NetworkPolicy via kube-router, which does NOT\n'
      printf '# exempt node-sourced kubelet health-probe traffic, so this policy as written\n'
      printf '# drops the liveness/readiness probes, marks the pod NotReady, and takes the\n'
      printf '# site down. Before applying: admit the probe source as well (an ipBlock for\n'
      printf '# the node/pod CIDR), then verify probes stay green on a live pod.\n'
      printf '#\n'
      printf '# Intent: the app is reachable only through the nginx ingress controller, so\n'
      printf '# no other pod can hit the API directly and bypass its TLS termination. The\n'
      printf '# selector uses the namespace automatic kubernetes.io/metadata.name label\n'
      printf '# rather than chart pod labels, which can change across chart versions.\n'
      ;;
  esac
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

    [[ $mode == write ]] && { header "$app" "$file"; doc_waiver "$app" "$file" "$body"; } > "$outdir/$file"
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
