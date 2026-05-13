#!/usr/bin/env bash
# Sync wrapper for the custom Grafana resources in this directory.
# Mirrors the kubes/<workload>/sync.sh convention.
#
# Usage:
#   ./sync.sh diff           # show what would change in Grafana
#   ./sync.sh apply          # push local resources to Grafana
#   ./sync.sh pull <kind> <uid>
#                            # pull one resource from Grafana into here
#
# Token: ~/.config/grafana/toktok-token (symlink to git-crypted file in the
# pippijn home repo). chmod 600. Service account "claude-code", Editor role.

set -euo pipefail

URL="${GRAFANA_URL:-https://toktok.grafana.net}"
TOKEN_FILE="${GRAFANA_TOKEN_FILE:-$HOME/.config/grafana/toktok-token}"

if [[ ! -r "$TOKEN_FILE" ]]; then
  echo "Token file not readable: $TOKEN_FILE" >&2
  exit 1
fi

export GRAFANA_URL="$URL"
export GRAFANA_TOKEN
GRAFANA_TOKEN="$(cat "$TOKEN_FILE")"

cmd="${1:-diff}"
shift || true

cd "$(dirname "$0")"

# Subdirs holding YAML resources for grizzly. Top-level README.md and
# sync.sh are NOT resource files, so we walk only these.
RESOURCE_DIRS=(dashboards alerts contact-points folders)

existing_dirs=()
for d in "${RESOURCE_DIRS[@]}"; do
  [[ -d "$d" ]] && existing_dirs+=("$d")
done

case "$cmd" in
  diff)
    for d in "${existing_dirs[@]}"; do
      nix-shell -p grizzly --run "grr diff '$d'"
    done
    ;;
  apply)
    for d in "${existing_dirs[@]}"; do
      nix-shell -p grizzly --run "grr apply '$d'"
    done
    ;;
  pull)
    if [[ $# -lt 2 ]]; then
      echo "usage: $0 pull <Kind> <uid> [dir]" >&2
      exit 1
    fi
    kind="$1"; uid="$2"; dir="${3:-.}"
    nix-shell -p grizzly --run "grr pull -e '$dir' -t '$kind/$uid'"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
