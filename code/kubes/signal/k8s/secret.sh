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
echo
# Not generated, and not written down here: these are IDENTITIES rather than
# credentials, and this repository is public. The importer needs them to know
# which logged lines are yours — irssi records your own messages under your nick
# exactly like anybody else's, so without them every line is somebody else's.
echo "For the IRC importer, add the nicks whose lines are your own"
echo "(the second is the one irssi falls back to on a second connection):"
echo "  kubectl -n $NS patch secret signal-secret -p '{\"stringData\":{\"IRC_SELF_NICK\":\"...\",\"IRC_SELF_NICK_ALT\":\"...\"}}'"
echo
echo "And the key that pulls the logs, as its OWN secret — a credential to"
echo "another cluster, with a different lifetime from the ones above:"
echo "  ssh-keygen -t ed25519 -N '' -C irclog-sync -f /root/irclog-sync"
echo "  ssh-keyscan -p 2230 10.100.0.1 > /root/irclog_known_hosts"
echo "  kubectl -n $NS create secret generic signal-irclog-sync \\"
echo "    --from-file=id_ed25519=/root/irclog-sync \\"
echo "    --from-file=known_hosts=/root/irclog_known_hosts"
echo
# NOT `rrsync`, which is what a command= for this should normally be: it is a
# python3 script and the irssi image has no python3, so a key pinned to it is
# inert rather than restricted. See kubes/vps/irssi/home/pippijn/bin/irclog-pull.
echo "Then authorise it on the far side, pinned to reading that one tree:"
echo "  printf 'command=\"/home/irssi/bin/irclog-pull\",restrict %s\\n' \\"
echo "    \"\$(cat /root/irclog-sync.pub)\" | ssh irc 'cat >> ~/.ssh/authorized_keys'"
echo "Prove it before trusting it — each of these must be refused:"
echo "  ssh -i /root/irclog-sync -p 2230 irssi@10.100.0.1 id        # a shell"
echo "  rsync -e '...' irssi@10.100.0.1:/etc/passwd .               # out of the tree"
echo "  rsync -e '...' ./anything irssi@10.100.0.1:xinutec/         # a write"
