-- vantage core schema: reports and their exploded checks.
--
-- A `report` is one upload from one producer run. `id` is the producer-minted
-- ULID and the idempotency key — re-sending the same report (spool replay after
-- a network flap) is a no-op. Per-report verdict counts are denormalised so the
-- overview needs no aggregation. `raw` keeps the original payload for
-- schema-evolution replay + debugging (pruned early; see report::retention).
--
-- Timestamps are stored as UTC DATETIME(3); the app binds/reads them as UTC
-- explicitly (never relying on the DB session timezone) and computes age in
-- Rust, so nothing here depends on the server's local time.
CREATE TABLE IF NOT EXISTS report (
    id           VARCHAR(26)     NOT NULL PRIMARY KEY,   -- producer ULID
    source       VARCHAR(64)     NOT NULL,               -- stamped from the token
    collector    VARCHAR(64)     NOT NULL,
    schema_ver   INT UNSIGNED    NOT NULL,
    collected_at DATETIME(3)     NOT NULL,               -- producer clock (truth)
    received_at  DATETIME(3)     NOT NULL,               -- vantage clock (diagnostic)
    duration_ms  BIGINT UNSIGNED NULL,
    interval_s   BIGINT UNSIGNED NULL,                   -- declared cadence → staleness
    ok           BOOLEAN         NOT NULL,               -- derived: no fail check
    n_pass       INT UNSIGNED    NOT NULL DEFAULT 0,
    n_warn       INT UNSIGNED    NOT NULL DEFAULT 0,
    n_fail       INT UNSIGNED    NOT NULL DEFAULT 0,
    n_skip       INT UNSIGNED    NOT NULL DEFAULT 0,
    raw          LONGTEXT        NULL,                    -- original payload
    INDEX idx_report_latest (source, collector, collected_at),
    INDEX idx_report_received (received_at)
) CHARACTER SET utf8mb4;

-- One row per check per report. `(source, collector, section, label)` is the
-- trend identity — denormalised off the report so the history query needs no
-- join. Cascade-deletes with its report.
CREATE TABLE IF NOT EXISTS check_result (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    report_id    VARCHAR(26)     NOT NULL,
    seq          INT UNSIGNED    NOT NULL,               -- order within the report
    source       VARCHAR(64)     NOT NULL,
    collector    VARCHAR(64)     NOT NULL,
    collected_at DATETIME(3)     NOT NULL,
    section      VARCHAR(128)    NOT NULL,
    label        VARCHAR(255)    NOT NULL,
    subject      VARCHAR(128)    NULL,
    verdict      VARCHAR(8)      NOT NULL,               -- pass|warn|fail|skip
    observed     TEXT            NULL,
    expected     TEXT            NULL,
    value        DOUBLE          NULL,                   -- optional numeric → charts
    unit         VARCHAR(32)     NULL,
    doc_ref      VARCHAR(255)    NULL,                   -- source's `ref` (file:line)
    detail       TEXT            NULL,
    INDEX idx_check_report (report_id, seq),
    INDEX idx_check_history (source, collector, section, label, collected_at),
    INDEX idx_check_problem (verdict, collected_at),
    CONSTRAINT fk_check_report FOREIGN KEY (report_id)
        REFERENCES report (id) ON DELETE CASCADE
) CHARACTER SET utf8mb4;
