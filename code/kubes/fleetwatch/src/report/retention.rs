//! Retention: bound growth without losing the trend history.
//!
//! Three tiers (docs/design.md §4.2):
//! - raw payloads (the heavy part, ~100 KB each) are dropped after
//!   `raw_retention_days` — kept only for schema-evolution replay + debugging.
//! - per-check rows after `check_retention_days` — a year of trends + margin.
//! - report summary rows are kept forever (tiny; they answer "since when").
//!
//! Run as a daily background task. Each step is idempotent and independent.

use anyhow::Result;
use chrono::{Duration, Utc};
use sqlx::MySqlPool;

/// One retention sweep. Returns `(raw_cleared, checks_deleted)` for logging.
pub async fn sweep(pool: &MySqlPool, raw_days: i64, check_days: i64) -> Result<(u64, u64)> {
    let raw_cutoff = (Utc::now() - Duration::days(raw_days)).naive_utc();
    let raw_cleared =
        sqlx::query("UPDATE report SET raw = NULL WHERE raw IS NOT NULL AND received_at < ?")
            .bind(raw_cutoff)
            .execute(pool)
            .await?
            .rows_affected();

    // Delete old checks directly (they don't cascade from report — reports are
    // kept). This can orphan a report of its checks, which is intended: the
    // denormalised counts on `report` preserve the historical rollup.
    let check_cutoff = (Utc::now() - Duration::days(check_days)).naive_utc();
    let checks_deleted = sqlx::query("DELETE FROM check_result WHERE collected_at < ?")
        .bind(check_cutoff)
        .execute(pool)
        .await?
        .rows_affected();

    Ok((raw_cleared, checks_deleted))
}
