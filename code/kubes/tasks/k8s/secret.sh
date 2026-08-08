#!/usr/bin/env bash
# Run ONCE on isis (as root) to create the tasks k8s secret.
#
#   ./secret.sh
#
# Generates the database passwords, the session secret and the agent token
# itself; prompts for the Nextcloud OAuth2 client. Get that from Nextcloud
# admin → Settings → Security → OAuth 2.0: client "tasks", redirect
# https://tasks.xinutec.org/auth/callback.
#
# **Prompted, not passed in.** The obvious shape — `NC_CLIENT_ID=... ./secret.sh`
# — writes the client secret into your shell history, into the process table
# while it runs, and into wherever the command was composed. Reading it here
# means the value goes from the keyboard to kubectl and lands nowhere else.
#
# ⚠ **NOT safe to re-run once the app holds work.** Re-running regenerates
# DB_PASSWORD, and MariaDB's own user still has the old one — so the app comes
# back up unable to reach a database that is perfectly healthy, with every task
# in it. Rotating for real means changing the password in MariaDB and in this
# secret together. Re-running the session secret alone would only cost one
# sign-in; re-running the agent token costs every Mac session its list until the
# new one is copied to ~/.config/tasks/token.
set -euo pipefail

read -rp  'Nextcloud client id: '     NC_CLIENT_ID
read -rsp 'Nextcloud client secret: ' NC_CLIENT_SECRET
echo

[ -n "$NC_CLIENT_ID" ]     || { echo "no client id given" >&2; exit 2; }
[ -n "$NC_CLIENT_SECRET" ] || { echo "no client secret given" >&2; exit 2; }

# /dev/urandom + base64 (coreutils) — openssl is not on the NixOS host's
# non-interactive root PATH.
# Strip URL-significant chars from the DB password so the DSN needs no escaping.
DB_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
DB_ROOT_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
SESSION_SECRET="$(head -c 36 /dev/urandom | base64 | tr -d '\n')"
# What a Claude session presents. Kept free of URL-significant characters too:
# it is copied by hand into a file on the Mac and typed into a header, and a
# token nobody can transcribe is a token nobody uses.
AGENT_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"

kubectl create secret -n tasks generic tasks-secret \
  --from-literal=DB_USER=tasks \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  --from-literal=DB_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
  --from-literal=DATABASE_URL="mysql://tasks:${DB_PASSWORD}@tasks-db/tasks" \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --from-literal=NC_CLIENT_ID="$NC_CLIENT_ID" \
  --from-literal=NC_CLIENT_SECRET="$NC_CLIENT_SECRET" \
  --from-literal=AGENT_TOKEN="$AGENT_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo
echo "tasks-secret written. Roll the deployment to pick it up:"
echo "  kubectl -n tasks rollout restart deploy/tasks"
echo
# Printed once, here, and nowhere else. It has to reach the Mac by hand — the
# alternative is a copy of it in a second system, which is one more place to
# leak from and one more to remember when it rotates.
echo "The agent token, for the Mac (~/.config/tasks/token, chmod 600):"
echo "  $AGENT_TOKEN"
