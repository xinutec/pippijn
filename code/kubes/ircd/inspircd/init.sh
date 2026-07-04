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

config_pull() {
  # Initial git ref.
  git rev-parse HEAD > /tmp/inspircd.hash

  while true; do
    # Every 5 minutes.
    sleep 300

    echo "[$(date)] Checking for new configs"
    git fetch
    git reset --hard origin/main
    # Check whether anything changed.
    git rev-parse HEAD > /tmp/inspircd.hash.new
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
