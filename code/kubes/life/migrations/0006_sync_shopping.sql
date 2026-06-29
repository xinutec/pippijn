-- Life schema, migration 0006: offline-first sync foundation (shopping slice).
-- See docs/proposals/offline-first.md. Adds a global, commit-ordered revision
-- counter and the per-row sync columns to shopping_items: a client-mintable
-- stable identity (ulid), the server revision (rev), and a soft-delete tombstone
-- (deleted_at) so deletes propagate to offline clients.

-- Global monotonic revision. Bumped inside each write transaction via
-- `UPDATE sync_rev SET val = LAST_INSERT_ID(val + 1)`; the row lock serialises
-- assignment to *commit* order, so a pull can never advance its checkpoint past a
-- rev that is assigned but not yet committed (review S1).
CREATE TABLE IF NOT EXISTS sync_rev (
    id  TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    val BIGINT UNSIGNED  NOT NULL
);
INSERT IGNORE INTO sync_rev (id, val) VALUES (1, 0);

ALTER TABLE shopping_items
    ADD COLUMN IF NOT EXISTS ulid       VARCHAR(26)     NULL,
    ADD COLUMN IF NOT EXISTS rev        BIGINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS deleted_at DATETIME        NULL,
    ADD COLUMN IF NOT EXISTS updated_at DATETIME        NULL;

-- ulid is the sync/API identity. UNIQUE permits multiple NULLs in MySQL/MariaDB,
-- so this holds before the one-time backfill (sync::backfill_shopping) fills them.
ALTER TABLE shopping_items ADD UNIQUE KEY IF NOT EXISTS uniq_shopping_ulid (ulid);
-- Pulls scan by rev; index it.
ALTER TABLE shopping_items ADD INDEX IF NOT EXISTS idx_shopping_rev (user_id, rev);
