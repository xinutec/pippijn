//! Persistence for the sync-conflict log.

use anyhow::Result;
use chrono::NaiveDateTime;
use sqlx::MySqlPool;

use super::{ConflictEntry, ConflictKind, NewConflict};

#[derive(sqlx::FromRow)]
struct Row {
    id: u64,
    kind: String,
    ulid: String,
    field: String,
    label: String,
    mine: String,
    theirs: String,
    created_at: NaiveDateTime,
}

/// Record one reported conflict. Values are stored verbatim (JSON-encoded by
/// the client); truncation would corrupt them, so oversized values are the
/// caller's problem — TEXT holds 64KB, far beyond any field here.
pub async fn create(pool: &MySqlPool, user_id: &str, new: NewConflict) -> Result<u64> {
    let res = sqlx::query(
        "INSERT INTO sync_conflicts (user_id, kind, ulid, field, label, mine, theirs) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(new.kind.to_string())
    .bind(&new.ulid)
    .bind(&new.field)
    .bind(&new.label)
    .bind(&new.mine)
    .bind(&new.theirs)
    .execute(pool)
    .await?;
    Ok(res.last_insert_id())
}

/// Unresolved conflicts, newest first.
pub async fn list(pool: &MySqlPool, user_id: &str) -> Result<Vec<ConflictEntry>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, kind, ulid, field, label, mine, theirs, created_at \
         FROM sync_conflicts WHERE user_id = ? AND resolved_at IS NULL \
         ORDER BY created_at DESC, id DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            let kind: ConflictKind = r.kind.parse().map_err(anyhow::Error::msg)?;
            Ok(ConflictEntry {
                id: r.id,
                kind,
                ulid: r.ulid,
                field: r.field,
                label: r.label,
                mine: r.mine,
                theirs: r.theirs,
                created_at: r.created_at.and_utc().timestamp_millis(),
            })
        })
        .collect()
}

/// Mark a conflict handled (keep-mine or use-other both end here). The row is
/// stamped, not deleted. Returns whether an unresolved row was resolved.
pub async fn resolve(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE sync_conflicts SET resolved_at = NOW() \
         WHERE id = ? AND user_id = ? AND resolved_at IS NULL",
    )
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}
