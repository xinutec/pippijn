-- life schema, migration 0012: the sync-conflict log.
-- When two devices edit the SAME field of the same row while one is offline,
-- the client's field-level merge keeps the pushing device's value and reports
-- the losing value here — nothing is ever silently discarded. Rows are kept
-- (resolved_at) rather than deleted, like everything else in this app.
CREATE TABLE IF NOT EXISTS sync_conflicts (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     VARCHAR(255)    NOT NULL,
    kind        VARCHAR(16)     NOT NULL,  -- shopping | todo
    ulid        CHAR(26)        NOT NULL,  -- the conflicted row
    field       VARCHAR(32)     NOT NULL,
    label       VARCHAR(255)    NOT NULL,  -- row display name at conflict time
    mine        TEXT            NOT NULL,  -- kept value (JSON-encoded)
    theirs      TEXT            NOT NULL,  -- losing value (JSON-encoded)
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME        NULL,
    INDEX idx_sync_conflicts_user (user_id, resolved_at)
);
