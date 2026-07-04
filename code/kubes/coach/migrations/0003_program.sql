-- coach 0003: periodized program (mesocycle) + explicit per-week targets +
-- optional day pins (the "hybrid" structure). Per-user. Append-only.
-- Signed integer types throughout so sqlx decodes to i32/i64 (not u*).

CREATE TABLE IF NOT EXISTS programs (
    id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     VARCHAR(255) NOT NULL,
    name        VARCHAR(128) NOT NULL,
    start_date  DATE         NOT NULL,
    weeks       INT          NOT NULL,
    -- 1-based week index that is the deload week; NULL = no deload.
    deload_week INT          NULL,
    active      BOOLEAN  NOT NULL DEFAULT 1,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NULL,
    deleted_at  DATETIME NULL,
    INDEX idx_programs_user (user_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The weekly pool: how much of each exercise to accumulate in a given week.
-- Stored explicitly per week (generated from a template + progression at
-- creation, but every number is visible and editable).
CREATE TABLE IF NOT EXISTS program_targets (
    id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    program_id  BIGINT NOT NULL,
    exercise_id BIGINT NOT NULL,
    week_index  INT    NOT NULL,                     -- 1-based
    target_sets INT    NOT NULL,                     -- weekly pool of sets
    rep_low     INT    NULL,
    rep_high    INT    NULL,
    load_kg     DOUBLE NULL,                          -- weighted_reps
    hold_s      INT    NULL,                          -- hold metric
    UNIQUE KEY uq_target (program_id, exercise_id, week_index),
    INDEX idx_targets_program (program_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Optional day pins: tie some of an exercise's weekly sets to a weekday when you
-- want structure. Unpinned volume floats in the weekly pool and the pacing
-- engine distributes it across remaining days (recovery-capped). weekday: 0=Mon.
CREATE TABLE IF NOT EXISTS program_pins (
    id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    program_id  BIGINT NOT NULL,
    exercise_id BIGINT NOT NULL,
    weekday     INT    NOT NULL,                      -- 0=Mon .. 6=Sun
    sets        INT    NOT NULL,
    UNIQUE KEY uq_pin (program_id, exercise_id, weekday),
    INDEX idx_pins_program (program_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
