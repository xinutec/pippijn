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

# The TLS certificate, mounted from the `irc-tls` secret that cert-manager
# renews. Watched here for the same reason the config is: inspircd reads its
# certificate when it rehashes and never again, so a renewed certificate sitting
# in the secret changes nothing until something sends a HUP.
#
# Nothing did, for a long time. cert-manager renewed into the secret while the
# process went on serving what it had loaded months earlier, and the gap only
# closed when a human ran `kubectl cp` by hand — every ~60 days, and once it was
# noticed with 26 days to spare. This poll is what that human was.
CERT=conf/tls/tls.crt

# What the running server would be serving if it rehashed right now: the config
# commit and the certificate on disk. One stamp for both, because the remedy for
# either changing is the same signal.
stamp() {
  git rev-parse HEAD
  # `|| true` so an ABSENT certificate leaves the loop running rather than
  # wedging it. That is not hypothetical — a local test build has no secret
  # mounted, and a pod from before the volume existed would have none either.
  # Losing the config half of this poll to a missing file would be a worse
  # failure than the one being fixed.
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
