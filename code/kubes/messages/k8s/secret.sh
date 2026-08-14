#!/usr/bin/env bash
# Create `messages-secret` (session signing key + Nextcloud OAuth client) in the
# `signal` namespace. The DB creds come from the existing `signal-secret` in the
# same namespace — not duplicated here.
#
# Register the OAuth2 client first in Nextcloud admin (dash.xinutec.org →
# Settings → Security → OAuth 2.0) with redirect URI:
#   https://messages.xinutec.org/auth/callback
# then pass its id/secret in:
#   NC_CLIENT_ID=... NC_CLIENT_SECRET=... ./secret.sh
set -euo pipefail

: "${NC_CLIENT_ID:?set NC_CLIENT_ID (from the Nextcloud OAuth2 client)}"
: "${NC_CLIENT_SECRET:?set NC_CLIENT_SECRET (from the Nextcloud OAuth2 client)}"

# N random bytes as hex. head + od + tr are always present; **openssl is not on
# isis's root PATH**, and this line called it — so on the host the script names
# in its own first sentence, it aborted at 127 and created nothing.
#
# Loudly, at least: in an assignment the substitution's status is the statement's,
# so `set -e` stops here. `health` had the same call inline in a `--from-literal`
# argument, where the status is discarded and the result is an empty credential
# and exit 0. Same missing binary, opposite failure, and the quiet one is worse.
rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# 32 bytes as 64 hex characters — what `openssl rand -hex 32` produced, so the
# existing session secret and any new one are the same shape.
SESSION_SECRET="$(rnd 32)"

kubectl create secret -n signal generic messages-secret \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --from-literal=NC_CLIENT_ID="$NC_CLIENT_ID" \
  --from-literal=NC_CLIENT_SECRET="$NC_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "messages-secret created/updated in namespace signal."
echo

# NOT generated here, and NOT part of messages-secret. This is a credential to
# another cluster with a different lifetime: rotating the session secret should
# not mean touching a key that is authorised on amun. The importer's read key is
# separate for the same reason — see signal/k8s/secret.sh.
#
# ⚠ THE POD WILL NOT START WITHOUT THIS SECRET. A missing secret volume leaves it
# Pending, so this runs BEFORE the manifest that mounts it, not after. That is
# the opposite order from the importer, where a missing key only meant an hourly
# job that failed.
cat <<'EOF'
The send path needs its own key, authorised on amun to do one thing:

  ssh-keygen -t ed25519 -N '' -C messages-irc-send -f /root/messages-irc-send
  ssh-keyscan -p 2230 10.100.0.1 > /root/messages_irc_known_hosts
  kubectl -n signal create secret generic messages-irc-send \
    --from-file=id_ed25519=/root/messages-irc-send \
    --from-file=known_hosts=/root/messages_irc_known_hosts

Then authorise it on the far side, pinned to sending and nothing else:

  printf 'command="/home/irssi/bin/irc-send",restrict %s\n' \
    "$(cat /root/messages-irc-send.pub)" | ssh irc 'cat >> ~/.ssh/authorized_keys'

And say who it may talk to. The list is a file on irssi's volume rather than a
constant, because this repository is public and who Pippijn talks to is not
something it should record. It is read fresh on every request, so adding a line
takes effect at once — no reload, no restart:

  ssh irc 'echo "<network> <nick>" >> ~/.irssi/archive-send.allow'

⚠ Fail-closed: with no such file, every send is refused.
EOF
