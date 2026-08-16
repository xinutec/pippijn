#!/bin/sh
# dev-lint: allow-no-strict-mode — container entrypoint: it must exec inspircd
# even if the startup `git pull` fails transiently; `set -e` would abort before
# exec and crashloop the server instead of starting with the baked-in config.

# The first time, the secrets need to be copied into the container. After
# that, these are persisted while the shared configs are not.
for file in conf/secret/server.conf data/permchannels.conf; do
  while [ ! -f "$file" ]; do
    echo "[$(date)] Waiting for $file..."
    sleep 30
  done
done

# The `irc-tls` secret, mounted by the Deployment. inspircd reads its
# certificate at rehash and never again, so a renewal reaches the wire only when
# something sends a HUP. Until 2026-08-16 that something was a person running
# `kubectl cp`, and the cert came within 26 days of expiring while a good one
# sat unused in the secret.
CERT=conf/tls/tls.crt

# What the server would serve if it rehashed now: the config commit and the
# certificate. One stamp for both, because either changing wants the same HUP.
stamp() {
  git rev-parse HEAD
  # `|| true`: a missing certificate must not wedge the loop and take the config
  # half down with it. A local build has no secret mounted.
  sha256sum "$CERT" 2>/dev/null || true
}

config_pull() {
  # Initial state: config commit + certificate.
  stamp > /tmp/inspircd.hash

  while true; do
    # Every 5 minutes.
    sleep 300

    echo "[$(date)] Checking for new configs"
    git fetch
    git reset --hard origin/main
    # Check whether anything changed.
    stamp > /tmp/inspircd.hash.new
    diff /tmp/inspircd.hash.new /tmp/inspircd.hash || {
      mv /tmp/inspircd.hash.new /tmp/inspircd.hash
      kill -HUP $(cat /var/run/inspircd.pid)
    }
  done
}

# Initial pull on startup.
git pull
# Continuous fetch and rehash loop.
config_pull &
exec /usr/bin/inspircd --nofork
