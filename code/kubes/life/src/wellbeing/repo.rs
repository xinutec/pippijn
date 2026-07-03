//! Persistence for wellbeing check-ins. All the CRUD travels the sync path
//! (`sync::repo::pull_wellbeing` / `push_wellbeing`); the only thing here is the
//! explicit trash restore, since a sync push can never clear a tombstone.

use anyhow::Result;
use sqlx::MySqlPool;

use crate::sync::repo::next_rev;

/// Restore a tombstoned check-in (trash/undo). Mirrors `todo::repo::restore`: a
/// fresh `rev` propagates the resurrected row to every device via the next pull.
pub async fn restore(pool: &MySqlPool, user_id: &str, ulid: &str) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let res = sqlx::query(
        "UPDATE wellbeing SET deleted_at = NULL, rev = ?, updated_at = NOW() \
         WHERE ulid = ? AND user_id = ? AND deleted_at IS NOT NULL",
    )
    .bind(rev)
    .bind(ulid)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(res.rows_affected() > 0)
}
