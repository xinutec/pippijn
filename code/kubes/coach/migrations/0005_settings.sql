-- coach 0005: per-user pacing settings. The active window + night cutoff bound
-- when the pacing engine will nudge; min_rest_min is the spacing between nudges.
-- Home geofence coordinates live on the phone, not here. Append-only.

CREATE TABLE IF NOT EXISTS settings (
    user_id           VARCHAR(255) NOT NULL PRIMARY KEY,
    timezone          VARCHAR(64)  NOT NULL DEFAULT 'Europe/London',
    window_start_hour INT NOT NULL DEFAULT 8,   -- earliest nudge
    window_end_hour   INT NOT NULL DEFAULT 21,  -- latest nudge
    -- After this hour the engine stops nudging and rolls remaining volume to
    -- tomorrow instead of encouraging a late cram.
    night_cutoff_hour INT NOT NULL DEFAULT 21,
    min_rest_min      INT NOT NULL DEFAULT 20,  -- spacing between nudges
    updated_at        DATETIME NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
