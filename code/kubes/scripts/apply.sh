#!/usr/bin/env bash
# Apply an app's Kubernetes manifests to a fleet host.
#
#   scripts/apply.sh life                 # dry run: show what would change
#   scripts/apply.sh --apply life         # actually apply
#   scripts/apply.sh --apply life 02-db.yaml
#   scripts/apply.sh --host amun <app>
#
# Dry run is the default and changes nothing, so a forgotten flag is safe.
#
# This exists because the deploy loop has two halves that need *different*
# identities, and doing it by hand gets it wrong:
#
#   * `git pull` runs as pippijn — ~pippijn IS the repo root, so pulling as
#     root fails with "detected dubious ownership". It also needs a login shell
#     (hence ssh rather than `sudo -u`), because git-crypt lives in pippijn's
#     nix profile and the clean filter fails with "external filter 'git-crypt
#     clean' failed 127" without it. That failure is intermittent — it only
#     bites when an encrypted file happens to be dirty — so the wrong form
#     appears to work right up until it doesn't.
#   * `kubectl apply` runs as root; passwordless sudo is not configured.
#
# It also refuses to apply manifests carrying a HELD_MARKER. life's
# 05-networkpolicy.yaml contains an applied DB policy AND an app policy marked
# NOT YET APPLIED in the same file: k3s enforces NetworkPolicy via kube-router,
# which does not exempt node-sourced kubelet probe traffic, so applying that
# second policy drops the liveness/readiness probes and takes the site down.
# `kubectl apply -f <app>/k8s/` would do exactly that.
set -euo pipefail

HELD_MARKER='NOT YET APPLIED'
host=isis.xinutec.org
apply=0
app=""
files=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --apply) apply=1; shift ;;
    --host) host="${2:?--host needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [[ -z $app ]]; then app=$1; else files+=("$1"); fi; shift ;;
  esac
done

[[ -n $app ]] || { echo "usage: $0 [--host HOST] [--apply] <app> [file...]" >&2; exit 2; }
[[ $host == *.* ]] || host="$host.xinutec.org"

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
local_dir="$repo/code/kubes/$app/k8s"
remote_dir="/home/pippijn/code/kubes/$app/k8s"

[[ -d $local_dir ]] || { echo "no such app: $local_dir" >&2; exit 1; }

# Default to every manifest except the ones whose filename marks them held.
if [[ ${#files[@]} -eq 0 ]]; then
  for f in "$local_dir"/*.yaml; do
    [[ $(basename "$f") == *held* ]] && continue
    files+=("$(basename "$f")")
  done
fi
[[ ${#files[@]} -gt 0 ]] || { echo "no manifests selected" >&2; exit 1; }

# A held resource sharing a file with an applied one cannot be filtered by
# filename, so refuse the file outright and make the human split it.
for f in "${files[@]}"; do
  if grep -qF "$HELD_MARKER" "$local_dir/$f"; then
    echo "refusing: $app/k8s/$f contains a resource marked '$HELD_MARKER'." >&2
    echo "Split the held resource into its own *-held.yaml (see coach/fleetwatch)" >&2
    echo "before applying this file." >&2
    exit 1
  fi
done

echo "== $app → $host"
printf '   %s\n' "${files[@]}"

# Preflight: the host deploys from git, so anything uncommitted or unpushed
# would silently not be part of what gets applied.
branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
[[ $branch == main ]] || { echo "refusing: on branch '$branch', not main" >&2; exit 1; }
if ! git -C "$repo" diff --quiet -- "$local_dir" ||
   ! git -C "$repo" diff --cached --quiet -- "$local_dir"; then
  echo "refusing: uncommitted changes under $app/k8s — the host deploys from git" >&2
  exit 1
fi
git -C "$repo" fetch -q origin main
local_head=$(git -C "$repo" rev-parse HEAD)
if [[ $local_head != $(git -C "$repo" rev-parse origin/main) ]]; then
  echo "refusing: HEAD is not pushed to origin/main" >&2
  exit 1
fi

# Half one: pull as pippijn, in a login shell.
echo "== pulling on $host as pippijn"
ssh "pippijn@$host" 'cd ~ && git pull --ff-only' 2>&1 | sed 's/^/   /'
remote_head=$(ssh "pippijn@$host" 'cd ~ && git rev-parse HEAD')
if [[ $remote_head != "$local_head" ]]; then
  echo "refusing: $host is at $remote_head, local HEAD is $local_head" >&2
  exit 1
fi
echo "   at $local_head"

remote_files=()
for f in "${files[@]}"; do remote_files+=("$remote_dir/$f"); done
kflags=$(printf -- '-f %q ' "${remote_files[@]}")

# Half two: everything below is root.
#
# `kubectl diff` is the authority on what would change, NOT the apply dry-run:
# `apply --dry-run=server` reports some resources as "configured" when nothing
# would actually change (NetworkPolicy is a reliable false positive — the API
# server defaults port protocol, so the merge looks like an edit). Basing the
# verdict on that would make this dry run overstate its own effects.
set +e
diff_out=$(ssh "root@$host" "kubectl diff $kflags" 2>&1)
diff_rc=$?
set -e

case $diff_rc in
  0) verdict="no changes — the live state already matches these manifests" ;;
  1) verdict="the diff above is what --apply would change" ;;
  *) echo "kubectl diff failed (rc=$diff_rc):" >&2
     printf '%s\n' "$diff_out" >&2
     exit 1 ;;
esac

echo "== diff (live → manifest)"
[[ -n $diff_out ]] && printf '%s\n' "$diff_out" | sed 's/^/   /'

# Kept as validation only: this is what rejects a malformed or invalid manifest
# before anything is written.
echo "== server-side validation"
ssh "root@$host" "kubectl apply $kflags --dry-run=server" 2>&1 | sed 's/^/   /'

if [[ $apply -eq 0 ]]; then
  echo
  echo "Dry run only — nothing was applied."
  echo "Verdict: $verdict"
  if [[ $diff_rc -eq 1 ]]; then
    cat <<'EOF'
A Deployment whose pod template changed restarts its pods; a database uses
strategy Recreate, so that is a brief outage rather than a rolling one.
EOF
  fi
  echo
  echo "Re-run with --apply to execute."
  exit 0
fi

echo "== applying"
ssh "root@$host" "kubectl apply $kflags" 2>&1 | sed 's/^/   /'

# Wait on whatever Deployments those files describe. custom-columns reads the
# same way whether kubectl returned one object or a List, and a while-read loop
# keeps this working on the Mac's bash 3.2 (no mapfile).
ssh "root@$host" \
  "kubectl get $kflags --no-headers -o custom-columns=K:.kind,NS:.metadata.namespace,N:.metadata.name 2>/dev/null || true" |
  while read -r kind ns name; do
    [[ $kind == Deployment ]] || continue
    echo "== rollout $ns/$name"
    # -n: this ssh reads from the loop's stdin otherwise, and eats the list.
    ssh -n "root@$host" "kubectl -n $ns rollout status deploy/$name --timeout=180s" 2>&1 | sed 's/^/   /'
  done

echo "== done"
