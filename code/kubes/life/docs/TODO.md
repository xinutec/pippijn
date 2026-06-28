# life — important TODOs

## ⚠️ BACKUP — the life DB is NOT backed up yet

**Do this before relying on life for real data.** The `life` MariaDB on isis
(namespace `life`, deployment `life-db`, PVC `life-db-pvc`) currently has **no
backup**. If the PVC is lost, all inventory/recipes/places are gone.

Plan (mirrors the fleet pattern): a scheduled `mysqldump` of the `life` database
folded into the **Mac-mini restic set** (`xinutec-infra/mac-mini/hm-agents.nix`,
daily 05:00). Restic backs up the dump file, not the live DB. See
`docs/design/overview.md` §6.

Deferred deliberately until the app is somewhat in use (real data worth
protecting). Revisit once the management UI lands and there's data to lose.

## Other

- **Live NC login** — placeholder NC client in prod; register the OAuth2 client
  and patch `life-secret` (see project memory / overview §2).
- **CalDAV** — bins-feed read + shop-trip writes (overview §5).
- **Frontend test runner** — none yet; Rust backend has full tests.
