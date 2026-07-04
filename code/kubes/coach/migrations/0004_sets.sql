-- coach 0004: the micro-log. One row per set logged "here and there"; they sum
-- toward the active program's weekly targets. Per-user. Append-only.
-- Signed integer types so sqlx decodes to i32/i64.

CREATE TABLE IF NOT EXISTS workout_sets (
    id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     VARCHAR(255) NOT NULL,
    exercise_id BIGINT       NOT NULL,
    -- The program this set counts toward (the active one at log time); NULL for
    -- off-program sets, which still show in history but don't burn down a target.
    program_id  BIGINT       NULL,
    logged_at   DATETIME NOT NULL,
    reps        INT      NULL,
    load_kg     DOUBLE   NULL,
    hold_s      INT      NULL,
    rpe         INT      NULL,                        -- 1..10 perceived effort
    note        VARCHAR(255) NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NULL,
    deleted_at  DATETIME NULL,
    INDEX idx_sets_user_time (user_id, logged_at),
    INDEX idx_sets_user_ex   (user_id, exercise_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
