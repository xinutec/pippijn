#!/usr/bin/env bash
# Create the `signal-secret` in the `signal` namespace with random credentials.
# Idempotent-ish: it will refuse to overwrite an existing secret (so you never
# rotate the DB password out from under a running DB, or the store passphrase
# out from under the linked device). Delete it by hand first if you really mean
# to rotate. Run against the isis k3s context. No secret values live in git.
set -euo pipefail

NS=signal

if kubectl -n "$NS" get secret signal-secret >/dev/null 2>&1; then
  echo "signal-secret already exists in namespace '$NS' — refusing to overwrite."
  echo "Delete it explicitly (kubectl -n $NS delete secret signal-secret) to rotate."
  exit 0
fi

gen() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; }

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

# Assigned before the command rather than substituted inside its arguments. `gen`
# reads /dev/urandom and will not fail, so nothing is broken here today — the
# shape is. A substitution inline in an argument has its exit status discarded,
# so `set -e` cannot see it and a generator that stopped working would be written
# into the secret as an empty password, with kubectl exiting 0. That is not
# hypothetical: `home` shipped it and `health` still had it until 2026-08-08.
DB_PASSWORD="$(gen)"
DB_ROOT_PASSWORD="$(gen)"

kubectl -n "$NS" create secret generic signal-secret \
  --from-literal=DB_USER=signal \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  --from-literal=DB_ROOT_PASSWORD="$DB_ROOT_PASSWORD"

echo "Created signal-secret in namespace '$NS'."
echo "After linking, add the account number:"
echo "  kubectl -n $NS patch secret signal-secret -p '{\"stringData\":{\"SIGNAL_NUMBER\":\"+44...\"}}'"
