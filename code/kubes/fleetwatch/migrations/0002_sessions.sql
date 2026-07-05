-- Human login sessions (Nextcloud identity → opaque server session). Distinct
-- from ingest auth: producers use bearer tokens (POST /api/reports), humans use
-- these cookie-backed sessions to read the dashboard. Nextcloud is touched only
-- at login; every request after authenticates against this row.
CREATE TABLE IF NOT EXISTS sessions (
    id           CHAR(64)     NOT NULL PRIMARY KEY,
    user_id      VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    expires_at   DATETIME     NOT NULL,
    INDEX idx_sessions_expires (expires_at)
);
