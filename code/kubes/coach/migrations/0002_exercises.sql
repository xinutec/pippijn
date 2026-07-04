-- coach 0002: the exercise catalog + built-in seed.
-- Global (not per-user): a single shared library for this personal app. Custom
-- additions go in the same table. Append-only migration; never edit in place.
-- Signed ids so sqlx decodes to i64.

CREATE TABLE IF NOT EXISTS exercises (
    id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    -- Stable identifier for built-ins (survives reseeding); UI edits keep it.
    slug        VARCHAR(64)  NOT NULL UNIQUE,
    name        VARCHAR(128) NOT NULL,
    equipment   ENUM('rings','bar','weights','mat','bodyweight') NOT NULL,
    -- Movement pattern doubles as the recovery grouping (pacing engine rests a
    -- pattern that was worked hard).
    pattern     ENUM('push','pull','legs','core') NOT NULL,
    metric      ENUM('reps','weighted_reps','hold') NOT NULL,
    unilateral  BOOLEAN  NOT NULL DEFAULT 0,
    is_active   BOOLEAN  NOT NULL DEFAULT 1,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed the kit: rings on a 2 m bar, adjustable weights, a mat. INSERT IGNORE so
-- reseeding is a no-op and a hand-edited row is never clobbered.
INSERT IGNORE INTO exercises (slug, name, equipment, pattern, metric, unilateral) VALUES
    ('pull_up',            'Pull-up',                'bar',       'pull', 'reps',          0),
    ('chin_up',            'Chin-up',                'bar',       'pull', 'reps',          0),
    ('ring_row',           'Ring row',               'rings',     'pull', 'reps',          0),
    ('weighted_pull_up',   'Weighted pull-up',       'bar',       'pull', 'weighted_reps', 0),
    ('db_row',             'Dumbbell row',           'weights',   'pull', 'weighted_reps', 1),
    ('ring_dip',           'Ring dip',               'rings',     'push', 'reps',          0),
    ('ring_push_up',       'Ring push-up',           'rings',     'push', 'reps',          0),
    ('push_up',            'Push-up',                'mat',       'push', 'reps',          0),
    ('overhead_press',     'Overhead press',         'weights',   'push', 'weighted_reps', 0),
    ('ring_support_hold',  'Ring support hold',      'rings',     'push', 'hold',          0),
    ('goblet_squat',       'Goblet squat',           'weights',   'legs', 'weighted_reps', 0),
    ('split_squat',        'Bulgarian split squat',  'weights',   'legs', 'weighted_reps', 1),
    ('pistol_squat',       'Pistol squat',           'bodyweight','legs', 'reps',          1),
    ('calf_raise',         'Calf raise',             'weights',   'legs', 'weighted_reps', 0),
    ('nordic_curl',        'Nordic curl',            'mat',       'legs', 'reps',          0),
    ('hanging_leg_raise',  'Hanging leg raise',      'bar',       'core', 'reps',          0),
    ('l_sit',              'L-sit',                  'rings',     'core', 'hold',          0),
    ('plank',              'Plank',                  'mat',       'core', 'hold',          0),
    ('dead_hang',          'Dead hang',              'bar',       'core', 'hold',          0);
