-- coach schema, migration 0001: auth tables.
-- Applied at boot by sqlx::migrate! (src/db.rs). Append-only: never edit a
-- shipped migration; add a new file instead.

CREATE TABLE IF NOT EXISTS sessions (
    id           CHAR(64)     NOT NULL PRIMARY KEY,
    user_id      VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    expires_at   DATETIME     NOT NULL,
    INDEX idx_sessions_expires (expires_at)
);
