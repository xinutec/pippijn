#!/usr/bin/env bash
# MariaDB major-version upgrade helper for the isis app databases. Run ON isis as root.
#
# Why this exists: MariaDB does NOT support downgrading. Once the data dir is upgraded
# the only way back is restoring a dump, so every upgrade must take a verified dump
# first and prove afterwards that no data went missing. Doing that by hand once per
# database is how a typo silently eats a table.
#
#   ./mariadb-major-upgrade.sh before <namespace> <database>
#       Pre-flight + dump. Hard-stops if the schema uses an identifier the target
#       version reserved. Dumps via `k3s crictl exec` (kubectl exec truncates dumps
#       this size -- see odin's backup-prepare.sh), checks the dump is not truncated,
#       and records exact row counts to /root/preupgrade/<ns>.counts.
#
#   ... then bump the image tag in the app's k8s manifest, commit/push/pull, and apply.
#       Set MARIADB_AUTO_UPGRADE=1 so the system tables migrate on first start.
#
#   ./mariadb-major-upgrade.sh after <namespace> <database>
#       Verifies the server version moved, no table vanished, no table SHRANK, and
#       CHECK TABLE is clean. Non-zero exit on any of those.
#
# Counts are COUNT(*), never information_schema.table_rows -- the latter is an InnoDB
# estimate and was ~1000 rows out on fleetwatch's `report`.
#
# Growth between the two runs is expected and fine: these apps keep serving during the
# upgrade, so the invariant is "nothing was LOST", not "nothing changed". A shrink is
# treated as failure even though a session could legitimately expire mid-window -- in a
# one-minute window that is rare enough to be worth a human look.
set -euo pipefail

# Reserved in MariaDB 12.0-12.3; an unquoted identifier with one of these names breaks.
RESERVED='"CONVERSION","ST_COLLECT","TO_DATE"'
OUT=/root/preupgrade

usage() { echo "usage: $0 {before|after} <namespace> <database>" >&2; exit 2; }
[ $# -eq 3 ] || usage
MODE=$1 NS=$2 DB=$3

POD_ID=$(k3s crictl pods --namespace "$NS" --name "$NS-db-.*" -q | head -1)
[ -n "$POD_ID" ] || { echo "no $NS-db pod found"; exit 1; }
CONTAINER=$(k3s crictl ps -p "$POD_ID" --name mariadb -q | head -1)
[ -n "$CONTAINER" ] || { echo "no mariadb container in $NS-db pod"; exit 1; }

# q <mariadb-flags> <sql>. The SQL arrives as $0 inside the container shell, so spaces
# and backticks in it are never re-parsed. MYSQL_PWD is read from the container's own
# environment, so the password never enters argv or any log.
q() {
  k3s crictl exec "$CONTAINER" sh -c \
    'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -u root '"$1"' -e "$0"' "$2"
}

record_counts() {
  q "-N -B" "SELECT table_name FROM information_schema.tables
              WHERE table_schema='$DB' AND table_type='BASE TABLE' ORDER BY table_name" \
  | tr -d '\r' | while read -r t; do
      [ -n "$t" ] || continue
      printf '%s\t%s\n' "$t" "$(q "-N -B $DB" "SELECT COUNT(*) FROM \`$t\`" | tr -d '\r')"
    done
}

case "$MODE" in
before)
  install -d -m 0700 "$OUT"
  echo "=== $NS: server version ==="
  q "-N -B" 'SELECT VERSION()'

  echo "=== $NS: reserved-identifier check ==="
  hits=$(q "-N -B" "
    SELECT (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema='$DB' AND UPPER(column_name) IN ($RESERVED))
         + (SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema='$DB' AND UPPER(table_name) IN ($RESERVED))" | tr -d '\r')
  [ "$hits" = "0" ] || { echo "ABORT: $hits identifier(s) collide with reserved words"; exit 1; }
  echo "no collisions"

  PV=$(kubectl -n "$NS" get pvc "$NS-db-pvc" -o jsonpath='{.spec.volumeName}')
  DBPATH="/var/lib/rancher/k3s/storage/${PV}_${NS}_${NS}-db-pvc/mariadb-data"
  [ -d "$DBPATH" ] || { echo "data dir not found: $DBPATH"; exit 1; }

  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  echo "=== $NS: dumping ==="
  k3s crictl exec "$CONTAINER" sh -c \
    'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump -u root --single-transaction --quick \
       --routines --triggers --all-databases > /var/lib/mysql/dump.sql'
  tail -c 100 "$DBPATH/dump.sql" | grep -q 'Dump completed' \
    || { echo "ABORT: dump truncated"; rm -f "$DBPATH/dump.sql"; exit 1; }
  echo "dump ok: $(wc -c < "$DBPATH/dump.sql") bytes"
  mv "$DBPATH/dump.sql" "$OUT/$NS-preupgrade-$STAMP.sql"
  zstd -3 -q -f "$OUT/$NS-preupgrade-$STAMP.sql" -o "$OUT/$NS-preupgrade-$STAMP.sql.zst"
  rm -f "$OUT/$NS-preupgrade-$STAMP.sql"

  record_counts > "$OUT/$NS.counts"
  echo "=== $NS: recorded row counts ==="
  cat "$OUT/$NS.counts"
  echo "dump: $OUT/$NS-preupgrade-$STAMP.sql.zst"
  ;;

after)
  [ -f "$OUT/$NS.counts" ] || { echo "no baseline -- run 'before' first"; exit 1; }
  echo "=== $NS: server version ==="
  q "-N -B" 'SELECT VERSION()'

  record_counts > "$OUT/$NS.counts.after"
  echo "=== $NS: row counts ==="
  awk -F'\t' '
    NR==FNR { before[$1]=$2; next }
            { after[$1]=$2 }
    END {
      bad = 0
      for (t in before) {
        if (!(t in after))      { printf "  LOST    %s (table gone)\n", t; bad=1; continue }
        d = after[t] - before[t]
        if (d < 0)   { printf "  SHRANK  %-28s %d -> %d (%d)\n", t, before[t], after[t], d; bad=1 }
        else if (d)  { printf "  grew    %-28s %d -> %d (+%d)\n", t, before[t], after[t], d }
        else         { printf "  same    %-28s %d\n", t, before[t] }
      }
      for (t in after) if (!(t in before)) printf "  new     %s\n", t
      exit bad
    }' "$OUT/$NS.counts" "$OUT/$NS.counts.after" \
    || { echo "ABORT: data loss detected"; exit 1; }

  echo "=== $NS: CHECK TABLE ==="
  tables=$(cut -f1 "$OUT/$NS.counts" | sed 's/^/`/;s/$/`/' | paste -sd, -)
  q "-B $DB" "CHECK TABLE $tables" | tee "/tmp/$NS-check.txt"
  # Column 3 is Msg_type; anything reporting 'error' fails the upgrade.
  awk -F'\t' 'NR>1 && tolower($3)=="error" { bad=1 } END { exit bad+0 }' "/tmp/$NS-check.txt" \
    || { echo "ABORT: CHECK TABLE reported an error"; exit 1; }
  echo "$NS: upgrade verified"
  ;;
*) usage ;;
esac
