-- Mental-wellbeing check-ins: a lightweight mood log. One row per *entry* (not
-- per day) — several a day is the point ("down this morning, better now"). A
-- pure-sync entity (offline-first), mirroring the shopping/todo shape.
--   recorded_at: when the feeling was (UTC; may be backdated from "now").
--   score:       1..5 (awful .. great).
--   note:        optional free text.
CREATE TABLE IF NOT EXISTS wellbeing (
    id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     VARCHAR(255)     NOT NULL,
    recorded_at DATETIME         NOT NULL,
    score       TINYINT UNSIGNED NOT NULL,
    note        TEXT             NULL,
    ulid        VARCHAR(26)      NULL,
    rev         BIGINT UNSIGNED  NOT NULL DEFAULT 0,
    deleted_at  DATETIME         NULL,
    created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME         NULL,
    UNIQUE KEY uniq_wellbeing_ulid (ulid),
    INDEX idx_wellbeing_user (user_id),
    INDEX idx_wellbeing_rev  (user_id, rev),
    INDEX idx_wellbeing_time (user_id, recorded_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
