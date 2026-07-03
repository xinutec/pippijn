//! Persistence for the to-do list.
//!
//! Sync-aware exactly like `shopping::repo`: every write allocates a global `rev`
//! in its transaction, stamps `updated_at`, and *soft*-deletes (sets `deleted_at`)
//! so deletes propagate to offline clients as tombstones. Reads hide tombstones.
//! The enums are stored as their snake_case strings and parsed at this boundary.

use anyhow::{Context, Result};
use chrono::NaiveDate;
use sqlx::MySqlPool;
use ulid::Ulid;

use super::types::{NewTodo, Todo, TodoPriority, TodoStatus, TodoType, UpdateTodo};
use crate::sync::repo::next_rev;

#[derive(sqlx::FromRow)]
struct Row {
    id: u64,
    title: String,
    todo_type: String,
    status: String,
    priority: Option<String>,
    notes: Option<String>,
    not_before: Option<NaiveDate>,
    due: Option<NaiveDate>,
}

impl TryFrom<Row> for Todo {
    type Error = anyhow::Error;
    fn try_from(r: Row) -> Result<Self> {
        Ok(Todo {
            id: r.id,
            title: r.title,
            todo_type: r
                .todo_type
                .parse::<TodoType>()
                .map_err(anyhow::Error::msg)?,
            status: r.status.parse::<TodoStatus>().map_err(anyhow::Error::msg)?,
            priority: r
                .priority
                .map(|p| p.parse::<TodoPriority>())
                .transpose()
                .map_err(anyhow::Error::msg)?,
            notes: r.notes,
            not_before: r.not_before,
            due: r.due,
        })
    }
}

/// To-dos: open first, then by title. Tombstoned rows are hidden.
pub async fn list(pool: &MySqlPool, user_id: &str) -> Result<Vec<Todo>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, title, todo_type, status, priority, notes, not_before, due FROM todos \
         WHERE user_id = ? AND deleted_at IS NULL ORDER BY status DESC, title",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(Todo::try_from).collect()
}

pub async fn get(pool: &MySqlPool, user_id: &str, id: u64) -> Result<Option<Todo>> {
    let row: Option<Row> = sqlx::query_as(
        "SELECT id, title, todo_type, status, priority, notes, not_before, due FROM todos \
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    row.map(Todo::try_from).transpose()
}

pub async fn create(pool: &MySqlPool, user_id: &str, new: NewTodo) -> Result<Todo> {
    let ulid = Ulid::new().to_string();
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let res = sqlx::query(
        "INSERT INTO todos (user_id, ulid, title, todo_type, status, priority, notes, \
         not_before, due, rev, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, NOW(), NOW())",
    )
    .bind(user_id)
    .bind(&ulid)
    .bind(&new.title)
    .bind(new.todo_type.to_string())
    .bind(new.priority.map(|p| p.to_string()))
    .bind(&new.notes)
    .bind(new.not_before)
    .bind(new.due)
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    let id = res.last_insert_id();
    tx.commit().await?;
    Ok(Todo {
        id,
        title: new.title,
        todo_type: new.todo_type,
        status: TodoStatus::Open,
        priority: new.priority,
        notes: new.notes,
        not_before: new.not_before,
        due: new.due,
    })
}

pub async fn update(
    pool: &MySqlPool,
    user_id: &str,
    id: u64,
    upd: UpdateTodo,
) -> Result<Option<Todo>> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let res = sqlx::query(
        "UPDATE todos SET title = ?, todo_type = ?, status = ?, priority = ?, notes = ?, \
         not_before = ?, due = ?, rev = ?, updated_at = NOW() \
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(&upd.title)
    .bind(upd.todo_type.to_string())
    .bind(upd.status.to_string())
    .bind(upd.priority.map(|p| p.to_string()))
    .bind(&upd.notes)
    .bind(upd.not_before)
    .bind(upd.due)
    .bind(rev)
    .bind(id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    get(pool, user_id, id).await.context("reload after update")
}

/// Soft delete: set the tombstone + a fresh `rev` so the delete syncs.
pub async fn delete(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let res = sqlx::query(
        "UPDATE todos SET deleted_at = NOW(), rev = ?, updated_at = NOW() \
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

/// Restore a tombstoned to-do (trash/undo). The ONE deliberate undelete path —
/// sync pushes can never clear a tombstone. The fresh `rev` propagates the
/// resurrected row to every device through the normal pull. (Links that were
/// removed alongside the to-do stay removed; reconnect by hand if needed.)
pub async fn restore(pool: &MySqlPool, user_id: &str, ulid: &str) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let rev = next_rev(&mut tx).await?;
    let res = sqlx::query(
        "UPDATE todos SET deleted_at = NULL, rev = ?, updated_at = NOW() \
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
