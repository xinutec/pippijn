#!/usr/bin/env nix-shell
#!nix-shell -i bash -p mariadb
# Local dev MariaDB for life. Data lives in .dev/ (gitignored). Idempotent:
# initialises the datadir on first run, then serves in the foreground on
# 127.0.0.1:3307. Creates the `life` database + a `life`/`life` dev account via
# an init file each boot.
#
#   ./scripts/dev-db.sh
#   DATABASE_URL=mysql://life:life@127.0.0.1:3307/life
#
# Ctrl-C to stop. Delete .dev/ to reset.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATADIR="$ROOT/.dev/mysql"
SOCKET="$ROOT/.dev/mysqld.sock"
INIT_SQL="$ROOT/.dev/init.sql"
PORT=3307

mkdir -p "$ROOT/.dev"

if [ ! -d "$DATADIR/mysql" ]; then
    echo "Initialising MariaDB data dir at $DATADIR ..."
    mariadb-install-db --no-defaults --datadir="$DATADIR" \
        --auth-root-authentication-method=normal >/dev/null
fi

cat >"$INIT_SQL" <<'SQL'
CREATE DATABASE IF NOT EXISTS life CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'life'@'127.0.0.1' IDENTIFIED BY 'life';
GRANT ALL PRIVILEGES ON life.* TO 'life'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

echo "Serving MariaDB on 127.0.0.1:$PORT (db: life) — Ctrl-C to stop"
exec mariadbd --no-defaults --datadir="$DATADIR" --socket="$SOCKET" \
    --port="$PORT" --bind-address=127.0.0.1 --init-file="$INIT_SQL"
