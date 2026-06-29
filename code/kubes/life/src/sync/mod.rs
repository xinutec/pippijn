//! Offline-first sync: a global, commit-ordered revision counter shared by all
//! syncable tables, plus per-collection pull/push (shopping first). See
//! `docs/proposals/offline-first.md`.

pub mod repo;
pub mod types;

use anyhow::Result;
use sqlx::MySqlPool;

/// Run the one-time backfills at startup, after migrations. Idempotent.
pub async fn backfill(pool: &MySqlPool) -> Result<()> {
    let n = repo::backfill_shopping(pool).await?;
    if n > 0 {
        tracing::info!("sync backfill: assigned ulid+rev to {n} shopping row(s)");
    }
    Ok(())
}
