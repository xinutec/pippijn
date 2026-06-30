-- To-do list: a typed task (`purchase` / `call` to start, extensible) with an
-- open/done status and optional notes. Offline-first from birth — the sync
-- columns (ulid / rev / deleted_at / updated_at) mirror shopping_items, so no
-- backfill is needed (every row is created with a ulid+rev). The typed,
-- directional connections live in a separate table (0009_todo_link).
CREATE TABLE IF NOT EXISTS todos (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    VARCHAR(255)    NOT NULL,
    title      VARCHAR(255)    NOT NULL,
    todo_type  VARCHAR(32)     NOT NULL,
    status     VARCHAR(32)     NOT NULL DEFAULT 'open',
    notes      TEXT            NULL,
    ulid       VARCHAR(26)     NULL,
    rev        BIGINT UNSIGNED NOT NULL DEFAULT 0,
    deleted_at DATETIME        NULL,
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME        NULL,
    UNIQUE KEY uniq_todos_ulid (ulid),
    INDEX idx_todos_user (user_id),
    INDEX idx_todos_rev (user_id, rev)
);
