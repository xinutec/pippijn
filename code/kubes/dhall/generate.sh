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

ask() { # app expr -> the model's normalised answer
  # Evaluate a plain (non-manifest) expression against an app model, for facts
  # the generator needs that do not appear in the rendered YAML. Typechecked like
  # any other expression: a misspelled field here fails, it does not default.
  printf 'let R = %s/lib/render.dhall in R.%s %s/apps/%s.dhall\n' \
    "$here" "$2" "$here" "$1" | dhall
}

ask_text() { # app expr -> the model's answer, as raw text
  # `dhall` renders a Text value with its quotes and escapes; `dhall text`
  # gives the string itself, which is what gets embedded in a comment.
  printf 'let R = %s/lib/render.dhall in R.%s %s/apps/%s.dhall\n' \
    "$here" "$2" "$here" "$1" | dhall text
}

netpol_anchor_file() { # app -> the manifest that carries the namespace's first Deployment
  # DL-K8S-NP-DEFAULT-DENY anchors on the first Deployment in the namespace, and
  # the waiver has to sit above that document's `---`. The MODEL decides which
  # one that is (R.hasDb); mapping the answer to a filename is the generator's
  # own business, since `manifests` above is where filenames live.
  if [[ $(ask "$1" hasDb) == True ]]; then
    printf '02-db.yaml'
  else
    printf '03-app.yaml'
  fi
}

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
  # The REASON comes from the model (R.storageWaiver), not from a case here.
  # This used to name one app and its justification inline, which meant adding a
  # second app with a volume was a shell edit far away from the volume — and
  # nothing forced the question to be answered at all. T.Durability is now a
  # required field, so a claim whose fate nobody stated does not typecheck.
  [[ $2 == 01-pvc.yaml ]] || { printf '%s' "$3"; return; }
  local why
  why=$(ask_text "$1" storageWaiver)
  [[ -n $why ]] || { printf '%s' "$3"; return; }

  # The marker is spelled in two pieces because a generator that EMITS a waiver
  # necessarily names it, and a whole `dev-lint: allow-<suffix>` string in this
  # file registers as a waiver sited here — which suppresses nothing, so
  # dev-lint reports DL-WAIVER-INEFFECTIVE. That audit is right ("a waiver that
  # waives nothing is a baseline entry nobody can see"); the marker belongs in
  # the rendered claim, not in the renderer.
  local waiver="# dev-lint: allow-""backup-coverage $why"

  # The LAST separator, not the first: `01-pvc.yaml:pvc appPvc` renders the
  # database's claim before the app's own, and only the app's is being waived.
  # Anchoring on the first would waive a db PVC that IS backed up, and dev-lint
  # fails a waiver that waives nothing.
  printf '%s' "$3" | awk '
    /^---$/ { last = NR }
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        print line[i]
        if (i == last) print WAIVER
      }
    }' WAIVER="$waiver"
}

header() { # app file netpol_anchor
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
      ;;
    *-held.yaml)
      # The marker string below is LOAD-BEARING, not decoration. THREE readers:
      # scripts/apply.sh refuses any file containing it, fleet_health.py's drift
      # sweep skips it so a deliberately-unapplied manifest is not reported as
      # permanent drift, and plan-run's ManifestsUnmixed probe — the one the
      # fleet's deploys actually go through, via deploy.sh — refuses on it too.
      # All three also skip on the *held* filename, so this is defence in depth.
      #
      # "Losing either would silently arm the policy below" was written when
      # there were two, and it has since been proven the hard way: plan-run
      # grepped for "dev-lint: held" from the day it was written until
      # 2026-08-05, a string no file here has ever contained, so its refusal
      # could not fire. Only the filename check stood. Add a reader here when one
      # appears — a marker with one reader is a guard that cannot fail.
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

  # DL-K8S-NP-DEFAULT-DENY anchors on the FIRST Deployment in the namespace, so
  # the waiver has to sit above that document's leading `---`. Which file that is
  # follows from the model (R.hasDb → netpol_anchor_file); it was hardcoded to
  # 02-db.yaml, which meant utterance — the only app with `db = None` — silently
  # got no waiver at all and failed the rule from the day it was deployed.
  #
  # The waiver TEXT stays here rather than in the model: it is a fact about
  # dev-lint, not about the deployment, and rendering drops comments anyway. Only
  # the placement decision comes from the model, which is the part that was wrong.
  #
  # dev-lint FAILS an ineffective waiver ("a waiver that waives nothing is a
  # baseline entry nobody can see"), so the first app to gain a real default-deny
  # policy fails here rather than being silently over-waived.
  if [[ ${3:-0} == 1 ]]; then
    printf '# dev-lint: allow-no-netpol — pre-existing: namespace needs a default-deny NetworkPolicy + allow-graph (network-hardening)\n'
  fi
}

status=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for src in "$here"/apps/*.dhall; do
  app=$(basename "$src" .dhall)
  outdir="$here/generated/$app"
  [[ $mode == write ]] && { rm -rf "$outdir"; mkdir -p "$outdir"; }
  : > "$tmp/$app.model.yaml"
  netpol_anchor=$(netpol_anchor_file "$app")

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

    is_anchor=0
    [[ $file == "$netpol_anchor" ]] && is_anchor=1

    [[ $mode == write ]] && { header "$app" "$file" "$is_anchor"; doc_waiver "$app" "$file" "$body"; } > "$outdir/$file"
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
