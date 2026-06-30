-- Typed, directional connections between a to-do and a target — another to-do or
-- an app entity. Offline-first like the `todos` table (own sync columns). The
-- endpoints are *soft refs* (ULID / id-string / room name), never hard FKs, so a
-- link and its endpoints sync on independent streams without ordering hazards
-- (offline-first proposal §6 / C2). See overview §4 "To-do".
--
--   from_ulid  ──kind──▶  (target_kind, target_ref)
--   kind        ∈ depends_on | subtask | related
--   target_kind ∈ todo | item | recipe | room | shopping | place
--   target_ref  = the target's ulid (todo) / id (db entity) / name (house room)
CREATE TABLE IF NOT EXISTS todo_links (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     VARCHAR(255)    NOT NULL,
    from_ulid   VARCHAR(26)     NOT NULL,
    kind        VARCHAR(16)     NOT NULL,
    target_kind VARCHAR(16)     NOT NULL,
    target_ref  VARCHAR(255)    NOT NULL,
    ulid        VARCHAR(26)     NULL,
    rev         BIGINT UNSIGNED NOT NULL DEFAULT 0,
    deleted_at  DATETIME        NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME        NULL,
    UNIQUE KEY uniq_todo_links_ulid (ulid),
    INDEX idx_todo_links_user (user_id),
    INDEX idx_todo_links_from (user_id, from_ulid),
    INDEX idx_todo_links_target (user_id, target_kind, target_ref),
    INDEX idx_todo_links_rev (user_id, rev)
);
