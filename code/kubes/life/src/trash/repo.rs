//! Trash listing + restore dispatch. The listing unions the tombstoned rows of
//! every entity kind; restores delegate to the owning feature repo so each kind
//! keeps its own semantics (history events, subtree grouping, sync revs).

use anyhow::Result;
use chrono::NaiveDateTime;
use sqlx::MySqlPool;

use super::{TrashEntry, TrashKind};
use crate::inventory::repo as inventory_repo;
use crate::recipes::repo as recipes_repo;
use crate::shopping::repo as shopping_repo;
use crate::todo::repo as todo_repo;
use crate::wellbeing::repo as wellbeing_repo;

#[derive(sqlx::FromRow)]
struct Row {
    ref_: String,
    name: String,
    deleted_at: NaiveDateTime,
}

impl Row {
    fn into_entry(self, kind: TrashKind) -> TrashEntry {
        TrashEntry {
            kind,
            ref_: self.ref_,
            name: self.name,
            deleted_at: self.deleted_at.and_utc().timestamp_millis(),
        }
    }
}

/// Everything in the user's trash, newest deletion first.
pub async fn list(pool: &MySqlPool, user_id: &str) -> Result<Vec<TrashEntry>> {
    // One query per kind; merged + sorted in memory (the trash is small).
    let queries: [(TrashKind, &str); 6] = [
        (
            TrashKind::Item,
            "SELECT CAST(i.id AS CHAR) AS ref_, COALESCE(p.name, i.name, '') AS name, \
             i.deleted_at AS deleted_at FROM items i \
             LEFT JOIN products p ON p.id = i.product_id \
             WHERE i.user_id = ? AND i.deleted_at IS NOT NULL",
        ),
        (
            TrashKind::Location,
            "SELECT CAST(id AS CHAR) AS ref_, name, deleted_at FROM locations \
             WHERE user_id = ? AND deleted_at IS NOT NULL",
        ),
        (
            TrashKind::Recipe,
            "SELECT CAST(id AS CHAR) AS ref_, name, deleted_at FROM recipes \
             WHERE user_id = ? AND deleted_at IS NOT NULL",
        ),
        (
            TrashKind::Shopping,
            // Pre-backfill rows can lack a ulid; they can't be restored by ref,
            // so hide them (backfill_shopping normally fixes this at boot).
            "SELECT ulid AS ref_, name, deleted_at FROM shopping_items \
             WHERE user_id = ? AND deleted_at IS NOT NULL AND ulid IS NOT NULL",
        ),
        (
            TrashKind::Todo,
            "SELECT ulid AS ref_, title AS name, deleted_at FROM todos \
             WHERE user_id = ? AND deleted_at IS NOT NULL AND ulid IS NOT NULL",
        ),
        (
            TrashKind::Wellbeing,
            // A check-in has no title; synthesise a label from its score.
            "SELECT ulid AS ref_, CONCAT('Check-in (', score, '/5)') AS name, deleted_at \
             FROM wellbeing WHERE user_id = ? AND deleted_at IS NOT NULL AND ulid IS NOT NULL",
        ),
    ];

    let mut entries = Vec::new();
    for (kind, sql) in queries {
        let rows: Vec<Row> = sqlx::query_as(sql).bind(user_id).fetch_all(pool).await?;
        entries.extend(rows.into_iter().map(|r| r.into_entry(kind)));
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
    Ok(entries)
}

/// Restore one entry. Returns whether anything was actually restored (false =
/// unknown ref / not deleted / malformed id).
pub async fn restore(pool: &MySqlPool, user_id: &str, kind: TrashKind, r: &str) -> Result<bool> {
    match kind {
        TrashKind::Item => match r.parse::<u64>() {
            Ok(id) => inventory_repo::restore_item(pool, user_id, id).await,
            Err(_) => Ok(false),
        },
        TrashKind::Location => match r.parse::<u64>() {
            Ok(id) => inventory_repo::restore_location(pool, user_id, id).await,
            Err(_) => Ok(false),
        },
        TrashKind::Recipe => match r.parse::<u64>() {
            Ok(id) => recipes_repo::restore_recipe(pool, user_id, id).await,
            Err(_) => Ok(false),
        },
        TrashKind::Shopping => shopping_repo::restore(pool, user_id, r).await,
        TrashKind::Todo => todo_repo::restore(pool, user_id, r).await,
        TrashKind::Wellbeing => wellbeing_repo::restore(pool, user_id, r).await,
    }
}
