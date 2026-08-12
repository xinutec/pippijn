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
  "05-networkpolicy.yaml:netpolDb netpolApp"
  "06-networkpolicy-app-held.yaml:netpolAppHeld"
)

# The same, for the static sites under web/org/xinutec/. A separate list because
# a site is a different KIND of thing, not an app with fields switched off — see
# lib/site.dhall. It renders no Namespace: all four share `web`, which
# kubes/web/k8s owns, and a second copy of a shared object is how two trees start
# fighting over it.
site_manifests=(
  "00-configmap.yaml:configMaps"
  "01-pvc.yaml:pvc"
  "02-deployment.yaml:deployment"
  "03-service.yaml:service"
  "04-ingress.yaml:ingress"
  "05-redirect.yaml:redirect"
)

site_tree() { # site -> its live manifest directory, relative to kubes/
  printf 'web/org/xinutec/%s/k8s' "$1"
}

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

site_render() { # site renderer -> YAML documents (nothing if the renderer opts out)
  local out
  out=$(printf 'let S = %s/lib/site.dhall in S.%s %s/sites/%s.dhall\n' \
    "$here" "$2" "$here" "$1" |
    dhall-to-yaml-ng --omit-empty --documents)
  [[ $out == "---"$'\n'"null" ]] && return 0
  printf '%s' "$out"
}

site_ask() { # site expr -> the model's normalised answer
  printf 'let S = %s/lib/site.dhall in S.%s %s/sites/%s.dhall\n' \
    "$here" "$2" "$here" "$1" | dhall
}

site_ask_text() { # site expr -> the model's answer, as raw text
  printf 'let S = %s/lib/site.dhall in S.%s %s/sites/%s.dhall\n' \
    "$here" "$2" "$here" "$1" | dhall text
}

compare() { # label live-dir model-file [unowned-file ...]
  # Concatenate the live tree and diff it against what the model produced, both
  # normalised. Each file needs its own document separator, or two files
  # concatenate into one malformed document and the diff becomes nonsense.
  local label=$1 dir=$2 model=$3; shift 3
  local live="$tmp/$label.live.yaml" f skip
  : > "$live"
  for f in "$dir"/*.yaml; do
    skip=0
    for u in "$@"; do
      [[ $(basename "$f") == "$u" ]] && skip=1
    done
    # A file the model DECLARED it does not own. Anything else that is present
    # and unmodelled still shows up in the diff, which is the point: an
    # undeclared manifest is a failure, and the only way to make one not a
    # failure is to say so in the model.
    (( skip )) && continue
    { printf -- '---\n'; cat "$f"; printf '\n'; } >> "$live"
  done
  if ! diff -u \
         <(python3 "$here/normalize.py" < "$live") \
         <(python3 "$here/normalize.py" < "$model") \
         > "$tmp/$label.diff"; then
    echo "===== $label: live tree → model"
    tail -n +3 "$tmp/$label.diff"
    echo
    status=1
  else
    echo "===== $label: model matches the live tree"
  fi
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
  # `--omit-empty` everywhere EXCEPT the NetworkPolicies, and the exception is
  # load-bearing rather than cosmetic. A default-deny selects the whole namespace
  # with `podSelector: {}` and denies a direction with an empty rule list — both
  # empty, both deleted by that flag. dev-lint then cannot RECOGNISE the policy:
  # measured 2026-08-11 by rendering scanner and running the linter over the
  # result, which reported `DL-K8S-NP-DEFAULT-DENY namespace scanner has no
  # default-deny NetworkPolicy` on a tree that had one.
  #
  # With the flag off, "empty" and "absent" become expressible separately, which
  # is why K.NetworkPolicy's rule lists are Optional — see lib/k8s.dhall.
  local flags=(--omit-empty --documents)
  case $2 in
    netpol*) flags=(--documents) ;;
  esac
  out=$(printf 'let R = %s/lib/render.dhall in R.%s %s/apps/%s.dhall\n' \
    "$here" "$2" "$here" "$1" |
    dhall-to-yaml-ng "${flags[@]}")
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

host_port_waiver() { # app file  (body on stdin) -> body, waiver injected
  # ⚠ NOT a `header()` waiver, which is where an earlier note on #689 said this
  # belonged. DL-K8S-HOST-PORT is `Scope.LINE` in dev-lint's registry, so the
  # marker has to land ON the `hostPort:` line (or the one directly above it) —
  # a comment in the file's header block would be reported UNKNOWN and waive
  # nothing. The netpol and backup-coverage waivers differ precisely here:
  # DL-K8S-NP-DEFAULT-DENY is FILE-scoped, so its marker may sit anywhere.
  #
  # As with those two, the model decides WHETHER (R.usesHostPort) and this
  # decides the text: the justification is a fact about `Reach.WireGuard`'s
  # rendering — the port is pinned to the tunnel address by `hostIP` on the very
  # next line — and is therefore identical for every app that gets one.
  # Reads the body from stdin rather than an argument, unlike doc_waiver: `$( )`
  # strips every trailing newline, so chaining the two through a variable would
  # quietly reshape the end of each file.
  [[ $2 == 03-app.yaml ]] || { cat; return; }
  [[ $(ask "$1" usesHostPort) == True ]] || { cat; return; }

  # Split for the same reason as doc_waiver's: a whole `dev-lint: allow-<suffix>`
  # string in this file registers as a waiver sited HERE, which suppresses
  # nothing and is itself reported as DL-WAIVER-INEFFECTIVE.
  local waiver="# dev-lint: allow-""host-port — bound to wg0 only, see hostIP"

  # Failing loudly if the anchor is not there. A waiver silently not emitted is
  # the same class of bug as one emitted where nothing needs it: the model said
  # this app has a hostPort, so a body without one means the two have drifted.
  awk -v w="$waiver" '
    /^ *hostPort: [0-9]+$/ && !done { print $0 " " w; done = 1; next }
    { print }
    END {
      if (!done) {
        print "generate.sh: usesHostPort but no hostPort line to waive" \
          > "/dev/stderr"
        exit 1
      }
    }'
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
  #
  # ...and only when the app has no APPLIED policy of its own. An app with a
  # real default-deny needs no waiver, and dev-lint fails one that waives
  # nothing, so this asks the model rather than keeping a second list here.
  if [[ ${3:-0} == 1 && $(ask "$1" hasAppliedNetpol) == False ]]; then
    printf '# dev-lint: allow-no-netpol — pre-existing: namespace needs a default-deny NetworkPolicy + allow-graph (network-hardening)\n'
  fi
}

site_header() { # site file
  printf '# GENERATED from dhall/sites/%s.dhall by dhall/generate.sh — do not edit.\n' "$1"
  printf '# Change the model and re-render; hand edits are overwritten.\n'
  case $2 in
    02-deployment.yaml)
      # Both waivers are facts about the STOCK nginx image, so every site
      # carries them and none of them is a per-site decision: the image writes
      # its own /tmp and pid file, and it ships with no resource block. They are
      # emitted here rather than modelled because a waiver is a statement about
      # dev-lint, not about the deployment — same split as the app renderer's.
      printf '#\n'
      printf '# dev-lint: allow-rootfs-rw — the stock nginx-unprivileged image writes /tmp and its pid file\n'
      printf '# dev-lint: allow-no-mem-limit — stock image, never sized (fix: size from kubectl top)\n'
      if [[ $(site_ask "$1" netpolWaiver) == True ]]; then
        # DL-K8S-NP-DEFAULT-DENY anchors on the FIRST Deployment in a namespace,
        # and all four sites share `web` — so exactly ONE of them may carry this
        # and the model says which. dev-lint fails a waiver that waives nothing,
        # so a second one would be caught rather than silently over-waiving.
        printf '# dev-lint: allow-no-netpol — pre-existing: namespace needs a default-deny NetworkPolicy + allow-graph (network-hardening)\n'
      fi
      ;;
  esac
}

site_waiver() { # site file body -> body, with any in-document waiver injected
  # As doc_waiver, and for the same reason: DL-DEPLOY-BACKUP-COVERAGE walks up
  # from the document's first key and stops at the leading `---`, so a line above
  # the separator is never seen. A site renders at most one claim, so this
  # anchors on the first separator rather than the last.
  [[ $2 == 01-pvc.yaml ]] || { printf '%s' "$3"; return; }
  local why
  why=$(site_ask_text "$1" storageWaiver)
  [[ -n $why ]] || { printf '%s' "$3"; return; }
  local waiver="# dev-lint: allow-""backup-coverage $why"
  printf '%s' "$3" | awk '
    /^---$/ && !done { print; print WAIVER; done = 1; next }
    { print }' WAIVER="$waiver"
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

    [[ $mode == write ]] && {
      header "$app" "$file" "$is_anchor"
      doc_waiver "$app" "$file" "$body" | host_port_waiver "$app" "$file"
    } > "$outdir/$file"
  done

  [[ $mode == check ]] && compare "$app" "$kubes/$app/k8s" "$tmp/$app.model.yaml"
done

for src in "$here"/sites/*.dhall; do
  site=$(basename "$src" .dhall)
  outdir="$here/generated/site-$site"
  [[ $mode == write ]] && { rm -rf "$outdir"; mkdir -p "$outdir"; }
  : > "$tmp/$site.model.yaml"

  for entry in "${site_manifests[@]}"; do
    file=${entry%%:*}
    body=""
    for r in ${entry#*:}; do
      body+=$(site_render "$site" "$r")
      body+=$'\n'
    done
    [[ -z ${body//[$'\n']/} ]] && continue

    printf '%s' "$body" >> "$tmp/$site.model.yaml"
    printf '\n' >> "$tmp/$site.model.yaml"

    [[ $mode == write ]] && { site_header "$site" "$file"; site_waiver "$site" "$file" "$body"; } > "$outdir/$file"
  done

  if [[ $mode == check ]]; then
    # The model states which files it does NOT own, and only those are excluded.
    mapfile -t unowned < <(site_ask_text "$site" unownedFiles | grep -v '^$' || true)
    compare "$site" "$kubes/$(site_tree "$site")" "$tmp/$site.model.yaml" "${unowned[@]}"
  fi
done

[[ $mode == write ]] && echo "rendered to $here/generated/"
exit $status
