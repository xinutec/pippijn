//! Persistence for to-do connections (typed, directional links). Sync-aware like
//! `todo::repo` — soft-delete + a global rev per write. Endpoints are *soft refs*
//! (`from` ulid + `target_ref`), never FKs, so links sync independently of their
//! endpoints. Links are create/delete only (re-point = delete + recreate).

use anyhow::Result;
use sqlx::MySqlPool;
use ulid::Ulid;

use super::types::{LinkKind, NewTodoLink, TargetKind, TodoLink};
use crate::sync::repo::next_rev;

#[derive(sqlx::FromRow)]
struct Row {
    id: u64,
    from_ulid: String,
    kind: String,
    target_kind: String,
    target_ref: String,
}

impl TryFrom<Row> for TodoLink {
    type Error = anyhow::Error;
    fn try_from(r: Row) -> Result<Self> {
        Ok(TodoLink {
            id: r.id,
            from: r.from_ulid,
            kind: r.kind.parse::<LinkKind>().map_err(anyhow::Error::msg)?,
            target_kind: r
                .target_kind
                .parse::<TargetKind>()
                .map_err(anyhow::Error::msg)?,
            target_ref: r.target_ref,
        })
    }
}

/// All of a user's connections. The client groups them by `from`/target. Hidden
/// rows (tombstones) excluded.
pub async fn list(pool: &MySqlPool, user_id: &str) -> Result<Vec<TodoLink>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, from_ulid, kind, target_kind, target_ref FROM todo_links \
         WHERE user_id = ? AND deleted_at IS NULL ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(TodoLink::try_from).collect()
}

pub async fn create(pool: &MySqlPool, user_id: &str, new: NewTodoLink) -> Result<TodoLink> {
    let ulid = Ulid::new().to_string();
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let res = sqlx::query(
        "INSERT INTO todo_links \
         (user_id, ulid, from_ulid, kind, target_kind, target_ref, rev, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())",
    )
    .bind(user_id)
    .bind(&ulid)
    .bind(&new.from)
    .bind(new.kind.to_string())
    .bind(new.target_kind.to_string())
    .bind(&new.target_ref)
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    let id = res.last_insert_id();
    tx.commit().await?;
    Ok(TodoLink {
        id,
        from: new.from,
        kind: new.kind,
        target_kind: new.target_kind,
        target_ref: new.target_ref,
    })
}

/// Soft delete: tombstone + fresh rev so the removal syncs.
pub async fn delete(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let res = sqlx::query(
        "UPDATE todo_links SET deleted_at = NOW(), rev = ?, updated_at = NOW() \
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(rev)
    .bind(id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(res.rows_affected() > 0)
}
