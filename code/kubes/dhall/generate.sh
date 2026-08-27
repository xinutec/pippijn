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

# Output file -> the renderers whose documents it concatenates, and which of
# those renderers must keep their empty values.
#
# ⚠ READ FROM THE MODEL since 2026-08-17 (#65), where they were two literal bash
# arrays and a `case` glob. All three are facts about the renderers, and they sat
# in a different file from the renderers. `lib/manifests.dhall` carries the long
# version of why, including which of #65's other candidates were measured and
# could NOT move.
#
# The shapes are unchanged — `<file>:<renderer> <renderer>` per line, and a
# space-separated name list — so the parsing below is the same parsing it always
# was, and this is a change of SOURCE rather than of format.
#
# `dhall text`, not `dhall-to-yaml`: these are already text and a YAML round trip
# would only add quoting to strip again.
manifest_lines() { # field -> the table, one line per output file
  dhall text <<< "($here/lib/manifests.dhall).$1"
}

mapfile -t manifests < <(manifest_lines appLines)
mapfile -t site_manifests < <(manifest_lines siteLines)

# Renderers whose output must NOT be passed through `--omit-empty`. Space
# separated and matched whole-word below, so `netpolApp` cannot match
# `netpolAppHeld` by prefix the way the glob it replaces could.
keep_empty=" $(manifest_lines keepEmptyRenderers) "

# ⚠ Failing here rather than rendering an empty fleet. A `dhall text` that fails
# leaves the array empty, every app renders no documents, and in check mode that
# reads as the whole tree deleted — which the per-app guard further down does
# catch, but sixteen times over and naming the wrong cause.
if (( ${#manifests[@]} == 0 )) || (( ${#site_manifests[@]} == 0 )); then
  echo "generate.sh: lib/manifests.dhall produced no table" >&2
  exit 1
fi

site_tree() { # site -> its live manifest directory, relative to kubes/
  printf 'web/org/xinutec/%s/k8s' "$1"
}

app_tree() { # app -> its live manifest directory, relative to kubes/
  # Almost every app's tree is `<name>/k8s`, and the two exceptions are not
  # sloppiness. `vps-pippijn` and `vps-simon` are two namespaces built from ONE
  # image: `vps/irssi/` holds the Dockerfile, init.sh and both home trees, so the
  # manifests live beside the source they deploy rather than in two top-level
  # directories that would separate them from it.
  #
  # ⚠ They were ONE DIRECTORY holding two manifests until 2026-08-27, and that is
  # unmodellable rather than merely untidy: `compare` concatenates every *.yaml in
  # the directory and diffs the whole SET against one model file, so two models
  # pointing at one directory would each read the other's manifest as an
  # undeclared extra — and an undeclared manifest is deliberately a failure.
  # Splitting them was chosen over making every renderer list-valued (which would
  # touch all 17 trees) or teaching `compare` per-file ownership (which would
  # weaken the check that caught the ircd cert drift on 2026-07-27).
  case $1 in
    vps-pippijn) printf 'vps/irssi/k8s/pippijn' ;;
    vps-simon) printf 'vps/irssi/k8s/simon' ;;
    *) printf '%s/k8s' "$1" ;;
  esac
}

# ⚠ A FAILED `ask` IS WORSE THAN A FAILED RENDER, and needs its own mechanism.
#
# `die_render`'s `exit` works because every renderer is called where a non-zero
# substitution aborts the assignment. These are not: `hasDb` and
# `hasAppliedNetpol` are read inside `[[ ]]`, which swallows the status, and
# `unownedFiles` through a process substitution, which does the same. An `exit`
# there kills the subshell and the script carries on.
#
# And carrying on is not merely untidy here, because these answers DECIDE things
# rather than describe them. A failed `hasDb` reads as `False`, which puts the
# DL-K8S-NP-DEFAULT-DENY waiver on `03-app.yaml` instead of `02-db.yaml` — a
# waiver that then waives nothing, silently, in a file that renders perfectly.
# That exact shape (the anchor decided outside the model) is what left utterance
# unwaived from the day it was deployed; the comment at `header` tells that story.
#
# A render failure would usually take the run down first, since both evaluate the
# same model — but not always. A typo'd EXPRESSION name fails `ask` while every
# renderer still succeeds, and that is precisely the case with no other symptom.
#
# So failure is recorded in a file, which a subshell CAN do, and the loop below
# refuses to write anything once it exists.
ask_failed="" # set once $tmp exists

die_ask() { # app expr rc
  {
    printf 'generate.sh: asking %s for R.%s FAILED — dhall exited %s\n' \
      "$1" "$2" "$3"
    printf '\n'
    cat "$render_err"
    printf '\n'
    printf 'This answer DECIDES a waiver placement, so nothing is written.\n'
  } >&2
  : > "$ask_failed"
  exit 1
}

ask() { # app expr -> the model's normalised answer
  # Evaluate a plain (non-manifest) expression against an app model, for facts
  # the generator needs that do not appear in the rendered YAML. Typechecked like
  # any other expression: a misspelled field here fails, it does not default.
  local out rc=0
  out=$(printf 'let R = %s/lib/render.dhall in R.%s %s/apps/%s.dhall\n' \
    "$here" "$2" "$here" "$1" | dhall 2>"$render_err") || rc=$?
  (( rc == 0 )) || die_ask "$1" "$2" "$rc"
  printf '%s' "$out"
}

ask_text() { # app expr -> the model's answer, as raw text
  # `dhall` renders a Text value with its quotes and escapes; `dhall text`
  # gives the string itself, which is what gets embedded in a comment.
  local out rc=0
  out=$(printf 'let R = %s/lib/render.dhall in R.%s %s/apps/%s.dhall\n' \
    "$here" "$2" "$here" "$1" | dhall text 2>"$render_err") || rc=$?
  (( rc == 0 )) || die_ask "$1" "$2" "$rc"
  printf '%s' "$out"
}

# ⚠ A FAILED RENDER MUST STOP THE SCRIPT, and neither `set -e` nor a return code
# will do it. Every renderer below is called inside `$( )`, and the substitution's
# status is whatever its LAST command returned — `printf "%s" "$out"`, which
# succeeds on the empty string. Measured 2026-08-14: with `set -euo pipefail` in
# force, `body+=$(render ...)` over a model with a type error carried on with rc=0.
#
# What that produced was not a visible failure. In WRITE mode the app's directory
# had already been emptied, so the run wrote nothing into it and printed
# "rendered to ..." — and copying that directory over a live tree deletes every
# manifest in it. In CHECK mode it printed `@@ -1,254 +0,0 @@`, the whole live
# tree removed and nothing on the model side, which reads exactly like a tree
# nobody has modelled yet: the ONE state a reader is trained to ignore. Three
# sites regressed that way at once (#815), and three apps did it again on
# 2026-08-14 while `T.Limits` was landing.
#
# `exit` DOES propagate: it kills the substitution's subshell with a non-zero
# status, and `set -e` then aborts the assignment in the caller. Also measured,
# because the whole point here is that the obvious mechanism was not working.
die_render() { # what expr rc  (stderr file at $render_err)
  {
    printf 'generate.sh: rendering %s through %s FAILED — dhall exited %s\n' \
      "$1" "$2" "$3"
    printf '\n'
    cat "$render_err"
    printf '\n'
    printf 'Nothing was written for this tree. Fix the model and re-run;\n'
    printf 'do NOT copy generated/ over a live tree until this renders.\n'
  } >&2
  exit 1
}

site_render() { # site renderer -> YAML documents (nothing if the renderer opts out)
  local out rc=0
  out=$(printf 'let S = %s/lib/site.dhall in S.%s %s/sites/%s.dhall\n' \
    "$here" "$2" "$here" "$1" |
    dhall-to-yaml-ng --omit-empty --documents 2>"$render_err") || rc=$?
  (( rc == 0 )) || die_render "$1" "S.$2" "$rc"
  [[ $out == "---"$'\n'"null" ]] && return 0
  printf '%s' "$out"
}

site_ask() { # site expr -> the model's normalised answer
  # Guarded exactly as `ask` is, and `netpolWaiver` is why it matters: all four
  # sites share the `web` namespace, so exactly ONE may carry the no-netpol
  # waiver. A silent `False` there drops it entirely and the namespace goes
  # unwaived — the same failure as utterance's, one type up.
  local out rc=0
  out=$(printf 'let S = %s/lib/site.dhall in S.%s %s/sites/%s.dhall\n' \
    "$here" "$2" "$here" "$1" | dhall 2>"$render_err") || rc=$?
  (( rc == 0 )) || die_ask "site $1" "$2" "$rc"
  printf '%s' "$out"
}

site_ask_text() { # site expr -> the model's answer, as raw text
  local out rc=0
  out=$(printf 'let S = %s/lib/site.dhall in S.%s %s/sites/%s.dhall\n' \
    "$here" "$2" "$here" "$1" | dhall text 2>"$render_err") || rc=$?
  (( rc == 0 )) || die_ask "site $1" "$2" "$rc"
  printf '%s' "$out"
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
  local out rc=0
  # `--omit-empty` everywhere except the renderers the MODEL exempts, and the
  # exception is load-bearing rather than cosmetic. A default-deny selects the
  # whole namespace with `podSelector: {}` and denies a direction with an empty
  # rule list — both empty, both deleted by that flag. dev-lint then cannot
  # RECOGNISE the policy: measured 2026-08-11 by rendering scanner and running
  # the linter over the result, which reported `DL-K8S-NP-DEFAULT-DENY namespace
  # scanner has no default-deny NetworkPolicy` on a tree that had one.
  #
  # With the flag off, "empty" and "absent" become expressible separately, which
  # is why K.NetworkPolicy's rule lists are Optional — see lib/k8s.dhall.
  #
  # ⚠ This was `case $2 in netpol*|appDeployment)` until 2026-08-17 — a GLOB over
  # renderer names deciding a dev-lint-visible property. A renderer added as
  # `netpolExtra` would have inherited the exception silently, and one needing it
  # under another name would silently not get it. `lib/manifests.dhall` states it
  # per renderer instead, and the space-padded match below is whole-word, so
  # `netpolApp` cannot match `netpolAppHeld` by prefix the way the glob could.
  #
  # `if`, not `[[ … ]] && flags=(…)`: a false test is that statement's exit
  # status, and under `set -e` the same shape has already cost this fleet a
  # script — see the note in scripts/netpol-reach.sh's row loop. It is safe here
  # only because more commands follow, which is a reason not to write it.
  local flags=(--omit-empty --documents)
  if [[ $keep_empty == *" $2 "* ]]; then
    flags=(--documents)
  fi
  out=$(printf 'let R = %s/lib/render.dhall in R.%s %s/apps/%s.dhall\n' \
    "$here" "$2" "$here" "$1" |
    dhall-to-yaml-ng "${flags[@]}" 2>"$render_err") || rc=$?
  # See `die_render`: the status has to be read here, because the caller cannot.
  (( rc == 0 )) || die_render "$1" "R.$2" "$rc"
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

host_path_waiver() { # app file  (body on stdin) -> body, waiver injected
  # DL-K8S-HOST-PATH, and the placement is NOT free choice. The rule anchors at
  # the hostPath's `path` VALUE, and the k8s engine honours a line-scoped waiver
  # on the flagged line or in the contiguous COMMENT block directly above it —
  # so a trailing marker on the `hostPath:` key line waives nothing, because a
  # key line ends the block. Measured both ways on observe, 2026-08-12.
  #
  # Injected on the `path:` line itself. Same division of labour as the other
  # two: the model answers WHETHER and WHY (R.hostPathWaiver returns the
  # volume's own justification, "" for none) and this holds only the syntax.
  [[ $2 == 03-app.yaml ]] || { cat; return; }
  local why
  why=$(ask "$1" hostPathWaiver | sed -e 's/^"//' -e 's/"$//')
  [[ -n $why ]] || { cat; return; }

  # Split for the same reason as the others: a whole `dev-lint: allow-<suffix>`
  # string in this file registers as a waiver sited HERE, which suppresses
  # nothing and is itself reported as DL-WAIVER-INEFFECTIVE.
  local waiver="# dev-lint: allow-""host-path — $why"

  # Failing loudly if the anchor is not there, as host_port_waiver does: the
  # model said this app mounts a host path, so a body without one means the two
  # have drifted and a silent skip would ship an unwaived finding.
  # ⚠ Anchored on the `path:` that FOLLOWS a `hostPath:` key, not on the first
  # `path:` in the document. The first version matched `/^ *path: /` alone and
  # put the marker on the readiness probe's `path: /healthz`, eleven lines above
  # the volume — which `--check` cannot catch, because it compares normalised
  # YAML and comments are not in it. dev-lint over the rendered tree is what
  # sees this, so run it after changing anything here.
  awk -v w="$waiver" '
    # `- hostPath:` when the volume sorts it first, `  hostPath:` otherwise.
    /^ *-? *hostPath:/ { in_hp = 1 }
    in_hp && /^ *path: / && !done { print $0 " " w; done = 1; in_hp = 0; next }
    { print }
    END {
      if (!done) {
        print "generate.sh: hostPathWaiver but no hostPath/path line to waive" \
          > "/dev/stderr"
        exit 1
      }
    }'
}

container_waivers() { # app file  (body on stdin) -> body, per-container waivers injected
  # DL-K8S-ROOTFS-RW and DL-K8S-NO-PROBE, and unlike the three above these are
  # PER CONTAINER rather than per file. Both are `Scope.LINE`, and dev-lint's
  # k8s engine anchors them on the container's FIRST line, so the marker goes in
  # the comment block directly above it. A file-level marker would waive every
  # container in the file — 03-app.yaml holds three and only two are writable —
  # and over-waiving is how a rule stops meaning anything.
  #
  # ⚠ THIS IS A RESTORATION, not a new rule. The hand-written manifests carried
  # these markers with their reasons; `5a00cd49` generated signal's tree from the
  # model on 2026-08-14 and they left with the file. dev-lint has reported all
  # four ever since, correctly, about decisions nobody disagreed with. What was
  # missing was somewhere for a reason to live that survives rendering, which is
  # what `T.RootFs.Writable { why }` now is.
  #
  # The model answers WHICH CONTAINER, WHICH RULE and WHY (R.containerWaivers,
  # tab-separated, one per line); this holds only the placement — the same
  # division as the other three.
  local spec
  spec=$(ask_text "$1" containerWaivers)
  [[ -n $spec ]] || { cat; return; }

  # `"# dev-lint: allow-" suffix` rather than a literal: a complete
  # `dev-lint: allow-<suffix>` string in this file registers as a waiver sited
  # HERE, which suppresses nothing and is reported as DL-WAIVER-INEFFECTIVE. The
  # other three split a constant for the same reason; this one is split by
  # construction, because the suffix comes from the model.
  awk -v spec="$spec" -v file="$2" '
    function spaces(n,   s) { s = ""; while (length(s) < n) s = s " "; return s }

    BEGIN {
      rows = split(spec, row, "\n")
      for (i = 1; i <= rows; i++) {
        if (row[i] == "") continue
        split(row[i], f, "\t")
        # A container can need more than one: the ingester is both writable and
        # unprobed. Accumulated rather than assigned, so the second does not
        # silently replace the first.
        marker = "# dev-lint: allow-" f[2]
        if (f[3] != "") marker = marker " — " f[3]
        want[f[1]] = want[f[1]] (want[f[1]] == "" ? "" : "\n") marker
      }
      listIndent = -1
    }

    { line[NR] = $0 }

    # `containers:` opens a list; anything back at or left of its indent closes
    # it. Without the close, a `name:` field of some later object at the right
    # depth would be read as a container name.
    match($0, /^ *containers:[ \t]*$/) {
      listIndent = index($0, "c") - 1
      cur = 0
      next
    }

    listIndent >= 0 {
      indent = match($0, /[^ ]/) - 1
      # ⚠ THE DASH SITS AT THE INDENT OF `containers:` ITSELF, not two deeper —
      # that is what
      # dhall-to-yaml-ng emits, and the first version of this looked for the
      # indented form and silently inserted nothing at all. Requiring EXACTLY
      # this indent is also what keeps `- name: MODE` inside an `env:` list from
      # reading as a new container.
      if (indent == listIndent && substr($0, indent + 1, 2) == "- ") {
        cur = NR
        at[NR] = indent
      } else if ($0 !~ /^ *$/ && indent <= listIndent) {
        listIndent = -1
        cur = 0
      } else if (cur && indent == listIndent + 2 && $0 ~ /^ *name: /) {
        nm = $0
        sub(/^ *name: /, "", nm)
        # dhall-to-yaml-ng double-quotes any string it did not have to leave
        # bare; nothing here ever emits the single-quoted form.
        gsub(/^"|"$/, "", nm)
        if (nm in want) { owner[cur] = nm; seen[nm] = 1 }
        cur = 0
      }
    }

    # ⚠ NO "the model named a container this file does not have" CHECK, unlike
    # the other three injectors, and the reason is structural rather than an
    # omission. `R.containerWaivers` answers for the whole APP; a CronJob
    # container lives in 04-cronjobs.yaml and a workload in 03-app.yaml, so every
    # call legitimately sees names belonging to the other file. Per file the two
    # states — "belongs elsewhere" and "gone" — are indistinguishable, and a
    # warning that fires on every run is one nobody reads.
    #
    # What catches a waiver that failed to land is dev-lint over the rendered
    # tree: the finding it was for is reported, unwaived. Run `~/Code/check`
    # after touching this, exactly as the note on host_path_waiver says.
    END {
      for (i = 1; i <= NR; i++) {
        if (i in owner) {
          n = split(want[owner[i]], ms, "\n")
          for (j = 1; j <= n; j++) print spaces(at[i]) ms[j]
        }
        print line[i]
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
    03-app.yaml)
      # DL-K8S-UNHARDENED-WORKLOAD is `Scope.FILE`, so unlike rootfs-rw and
      # no-probe this one belongs in the header rather than beside its container.
      #
      # ⚠ ANOTHER RESTORATION. The hand-written manifest carried this marker with
      # its reason, and `5a00cd49` rendered the tree from the model without it.
      # The reason has been in the model the whole time — `T.Hardening.Unhardened
      # { why }` cannot be written without one — and could not get out, because
      # dhall-to-yaml-ng emits no comments. This is the way out.
      unhardened_why=$(ask_text "$1" unhardenedWaiver)
      if [[ -n $unhardened_why ]]; then
        printf '#\n'
        # Split like the netpol waiver below and for the same reason: a complete
        # marker in this file registers as a waiver sited HERE.
        printf '# dev-lint: allow-''unhardened — %s\n' "$unhardened_why"
      fi
      ;;
    *-held.yaml)
      # The marker string below is LOAD-BEARING, not decoration. TWO readers,
      # and there were three until scripts/apply.sh was deleted on 2026-08-16:
      # fleet_health.py's drift sweep skips it so a deliberately-unapplied
      # manifest is not reported as permanent drift, and plan-run's
      # ManifestsUnmixed probe — the one the fleet's deploys actually go
      # through, via deploy.sh — refuses any file containing it. Both also skip
      # on the *held* filename, so this is defence in depth.
      # Both spellings are now compared by mac-mini/test_held_marker.py, which
      # covers the whole convention for the first time: the third reader was the
      # one it could not reach.
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
  #
  # `allow-''<suffix>` — the same split as doc_waiver's and host_port_waiver's,
  # and for the same reason. It was added here on 2026-08-12: dev-lint's YAML
  # engines started reporting which rules they ran, which let it condemn a waiver
  # that suppressed nothing — and it read these three printf strings as waivers
  # sited in generate.sh, where they suppress nothing at all. The emitted text is
  # unchanged; `''` closes and reopens the quote and contributes no character.
  if [[ ${3:-0} == 1 && $(ask "$1" hasAppliedNetpol) == False ]]; then
    printf '# dev-lint: allow-''no-netpol — pre-existing: namespace needs a default-deny NetworkPolicy + allow-graph (network-hardening)\n'
  fi
}

site_header() { # site file
  printf '# GENERATED from dhall/sites/%s.dhall by dhall/generate.sh — do not edit.\n' "$1"
  printf '# Change the model and re-render; hand edits are overwritten.\n'
  case $2 in
    02-deployment.yaml)
      # NO rootfs-rw / no-mem-limit waiver here, and it is worth saying why one
      # is not missing. Both WERE emitted until 2026-08-12, and both waived
      # nothing: dev-lint's `image_profile` already carves every `nginx` image
      # out of DL-K8S-ROOTFS-RW and DL-K8S-LIMITS-MEM, because they are facts
      # about a stock image nobody here builds. Two mechanisms said the same
      # thing and the quieter one won, so the marker sat inert in three live
      # trees until the linter learned to condemn a waiver that waives nothing.
      #
      # The remaining waiver below is a different kind of statement: it is about
      # THIS namespace, not about the image, so no carve-out can pre-empt it.
      if [[ $(site_ask "$1" netpolWaiver) == True ]]; then
        printf '#\n'
        # DL-K8S-NP-DEFAULT-DENY anchors on the FIRST Deployment in a namespace,
        # and all four sites share `web` — so exactly ONE of them may carry this
        # and the model says which. dev-lint fails a waiver that waives nothing,
        # so a second one would be caught rather than silently over-waiving.
        printf '# dev-lint: allow-''no-netpol — pre-existing: namespace needs a default-deny NetworkPolicy + allow-graph (network-hardening)\n'
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

# Where a renderer's stderr lands, so a dhall type error can be printed WITH the
# name of the tree and the renderer that hit it. Left un-redirected it still
# reached the terminal, but sixteen trees up from the diff that it caused, which
# is how it kept being read as noise.
render_err="$tmp/render.err"

# See `die_ask`: a subshell cannot abort this script, but it can leave a mark.
ask_failed="$tmp/ask.failed"

for src in "$here"/apps/*.dhall; do
  app=$(basename "$src" .dhall)
  outdir="$here/generated/$app"
  [[ $mode == write ]] && { rm -rf "$outdir"; mkdir -p "$outdir"; }
  : > "$tmp/$app.model.yaml"
  netpol_anchor=$(netpol_anchor_file "$app")
  # `netpol_anchor_file` reads `hasDb` inside `[[ ]]`, so a failure there could
  # not stop itself. This is where it stops. Repeated after the manifest loop
  # because `header` and `host_port_waiver` ask again, from inside `[[ ]]` too.
  if [[ -e $ask_failed ]]; then exit 1; fi

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
      doc_waiver "$app" "$file" "$body" \
        | host_port_waiver "$app" "$file" \
        | host_path_waiver "$app" "$file" \
        | container_waivers "$app" "$file"
    } > "$outdir/$file"
  done

  if [[ -e $ask_failed ]]; then exit 1; fi

  # ⚠ SECOND LINE OF DEFENCE, and it catches what the first cannot: a renderer
  # that SUCCEEDS and returns nothing. `die_render` covers a dhall error, but an
  # expression that legitimately evaluates to an empty list renders no document
  # — that is the design (`pvc` on an app with no volume), and it is
  # indistinguishable per-renderer from a mistake. Across the WHOLE tree it is
  # not: no app in this fleet renders zero documents, so an empty model file
  # means something went wrong that nobody has named yet.
  #
  # Stated as its own check rather than folded into `compare`, because write mode
  # needs it just as much — that is the mode that empties a directory first.
  if [[ ! -s $tmp/$app.model.yaml ]]; then
    printf 'generate.sh: %s rendered NO documents at all.\n' "$app" >&2
    printf 'Every app renders at least a Namespace and a Deployment, so this is\n' >&2
    printf 'a fault rather than an empty app. Do NOT copy generated/%s over the\n' "$app" >&2
    printf 'live tree — in check mode this appears as the whole tree deleted.\n' >&2
    exit 1
  fi

  if [[ $mode == check ]]; then
    # The model states which files it does NOT own, and only those are excluded
    # — the same contract the site loop has had since the sites landed. An app
    # needed it once `messages` arrived: `00-letsencrypt-dns-issuer.yaml` is a
    # cluster-scoped cert-manager ClusterIssuer, one-time isis setup rather than
    # part of any app, and the model has no type for it.
    mapfile -t unowned < <(ask_text "$app" unownedFiles | grep -v '^$' || true)
    if [[ -e $ask_failed ]]; then exit 1; fi
    compare "$app" "$kubes/$(app_tree "$app")" "$tmp/$app.model.yaml" "${unowned[@]}"
  fi
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

  if [[ -e $ask_failed ]]; then exit 1; fi

  if [[ ! -s $tmp/$site.model.yaml ]]; then
    printf 'generate.sh: site %s rendered NO documents at all.\n' "$site" >&2
    printf 'A site renders at least a Deployment, a Service and an Ingress.\n' >&2
    exit 1
  fi

  if [[ $mode == check ]]; then
    # The model states which files it does NOT own, and only those are excluded.
    mapfile -t unowned < <(site_ask_text "$site" unownedFiles | grep -v '^$' || true)
    if [[ -e $ask_failed ]]; then exit 1; fi
    compare "$site" "$kubes/$(site_tree "$site")" "$tmp/$site.model.yaml" "${unowned[@]}"
  fi
done

# ── clusters.json: which cluster each tree belongs to, as DATA ───────────────
#
# `plan-run deploy` needs the host BEFORE it builds its goals, because the goals
# name it — so it cannot ask a probe, and `deploy::desired` is pure. The two
# alternatives were both worse: evaluating Dhall at deploy time puts a
# `nix develop` on the path of every deploy and makes this flake a deploy
# dependency (which is what the deleted `scripts/apply.sh` did, once per run);
# and a second copy of the mapping in the plan's own tables would be two sources
# of truth for a question that already has one — the failure #692 was.
#
# So the model renders the answer, the same way it renders manifests, and the
# plan reads a committed file. Unlike `generated/`, this one IS committed: it is
# read by another repository, which cannot run this script.
#
# ⚠ The JSON is built by `dhall-to-json`, not by printf. Only the EXPRESSION is
# assembled here, so a tree whose model lacks `placement`, or a misspelled
# `clusterHosts`, is a Dhall type error rather than a quoting accident in bash.
#
# ⚠ Values are ARRAYS since 2026-08-26 — a subject may be placed on more than one
# cluster. `plan-run` reads this file, so its reader changed in the same breath.
#
# Keyed by LEAF name: `web/org/xinutec/slides` is the site `slides`. An app and a
# site cannot share a name, which `scripts/apply.sh` already relied on.
clusters_expr() {
  local first=1 leaf
  printf 'let R = %s/lib/render.dhall\nlet S = %s/lib/site.dhall\nin  toMap\n{ ' "$here" "$here"
  for src in "$here"/apps/*.dhall; do
    leaf=$(basename "$src" .dhall)
    (( first )) || printf '\n, '
    first=0
    printf '%s = R.clusterHosts %s/apps/%s.dhall' "$leaf" "$here" "$leaf"
  done
  for src in "$here"/sites/*.dhall; do
    leaf=$(basename "$src" .dhall)
    (( first )) || printf '\n, '
    first=0
    printf '%s = S.clusterHosts %s/sites/%s.dhall' "$leaf" "$here" "$leaf"
  done
  printf '\n}\n'
}

clusters_rendered=$(clusters_expr | dhall-to-json 2>"$render_err") || {
  printf 'generate.sh: the app -> cluster map did not evaluate:\n' >&2
  cat "$render_err" >&2
  exit 1
}

if [[ $mode == write ]]; then
  printf '%s\n' "$clusters_rendered" > "$here/clusters.json"
else
  # Committed, so `--check` compares against the file rather than re-deriving
  # it: the question this row answers is whether what the OTHER repository reads
  # still matches the model, and re-deriving both sides could not answer it.
  if ! printf '%s\n' "$clusters_rendered" | diff -u "$here/clusters.json" - > "$tmp/clusters.diff"; then
    printf 'generate.sh: clusters.json is stale — the model says otherwise.\n' >&2
    printf 'Run ./generate.sh to update it; plan-run deploy reads this file.\n' >&2
    sed 's/^/   /' "$tmp/clusters.diff" >&2
    status=1
  fi
fi

[[ $mode == write ]] && echo "rendered to $here/generated/ and $here/clusters.json"
exit $status
