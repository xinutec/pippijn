//! Persistence for the offline-first sync protocol. The revision counter is
//! shared by every syncable table; the pull/push handlers are per collection
//! (shopping first — see `docs/proposals/offline-first.md`).

use anyhow::Result;
use sqlx::{MySqlConnection, MySqlPool};
use ulid::Ulid;

use super::types::{Checkpoint, PullResponse, PushEntry, ShoppingDoc};

/// Allocate the next global revision, **inside the caller's transaction**. The
/// `LAST_INSERT_ID(val + 1)` trick bumps and returns the counter atomically; the
/// row lock it takes is held until the caller commits, so revisions are handed out
/// in *commit* order — a pull can never advance past a rev that is assigned but not
/// yet committed (review S1). Must run on the same connection as the write it
/// stamps.
pub async fn next_rev(conn: &mut MySqlConnection) -> sqlx::Result<u64> {
    let res = sqlx::query("UPDATE sync_rev SET val = LAST_INSERT_ID(val + 1) WHERE id = 1")
        .execute(&mut *conn)
        .await?;
    Ok(res.last_insert_id())
}

#[derive(sqlx::FromRow)]
struct DocRow {
    ulid: String,
    name: String,
    quantity: Option<f64>,
    unit: Option<String>,
    barcode: Option<String>,
    done: bool,
    // A boolean SQL expression decodes as an integer, so map it explicitly.
    deleted: i64,
    rev: u64,
}

impl From<DocRow> for ShoppingDoc {
    fn from(r: DocRow) -> Self {
        ShoppingDoc {
            ulid: r.ulid,
            name: r.name,
            quantity: r.quantity,
            unit: r.unit,
            barcode: r.barcode,
            done: r.done,
            deleted: r.deleted != 0,
            rev: r.rev,
        }
    }
}

/// One-time backfill: give every pre-sync shopping row a ULID + revision so it is
/// pulled by clients on first sync. Idempotent — only touches rows whose `ulid` is
/// still NULL, so it is a cheap no-op once done; safe to run on every boot.
pub async fn backfill_shopping(pool: &MySqlPool) -> Result<u64> {
    let mut total = 0u64;
    loop {
        let ids: Vec<(u64,)> =
            sqlx::query_as("SELECT id FROM shopping_items WHERE ulid IS NULL LIMIT 200")
                .fetch_all(pool)
                .await?;
        if ids.is_empty() {
            break;
        }
        for (id,) in ids {
            let mut tx = pool.begin().await?;
            let rev = next_rev(&mut tx).await?;
            sqlx::query(
                "UPDATE shopping_items SET ulid = ?, rev = ?, updated_at = NOW() \
                 WHERE id = ? AND ulid IS NULL",
            )
            .bind(Ulid::new().to_string())
            .bind(rev)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            total += 1;
        }
    }
    Ok(total)
}

/// Pull: documents (including tombstones) with `rev` past the checkpoint, in rev
/// order, plus the advanced checkpoint. Scoped to one user.
pub async fn pull_shopping(
    pool: &MySqlPool,
    user_id: &str,
    since: u64,
    limit: u64,
) -> Result<PullResponse> {
    let rows: Vec<DocRow> = sqlx::query_as(
        "SELECT ulid, name, quantity, unit, barcode, done, \
         CAST(deleted_at IS NOT NULL AS SIGNED) AS deleted, rev \
         FROM shopping_items WHERE user_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?",
    )
    .bind(user_id)
    .bind(since)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let checkpoint = Checkpoint {
        rev: rows.last().map_or(since, |r| r.rev),
    };
    Ok(PullResponse {
        documents: rows.into_iter().map(Into::into).collect(),
        checkpoint,
    })
}

/// Push: apply each change as an idempotent upsert keyed by ULID, guarded by the
/// client's assumed revision (optimistic concurrency). Returns the current server
/// doc for every rejected (stale) change so the client can resolve and re-push —
/// the LWW policy lives in the client's conflict handler; the server only enforces
/// the rev guard.
pub async fn push_shopping(
    pool: &MySqlPool,
    user_id: &str,
    entries: Vec<PushEntry>,
) -> Result<Vec<ShoppingDoc>> {
    let mut conflicts = Vec::new();
    for entry in entries {
        let new = entry.new_document_state;
        let assumed_rev = entry.assumed_master_state.map(|d| d.rev);

        let mut tx = pool.begin().await?;
        // Lock this user's row (if any) for the rest of the transaction.
        let current: Option<DocRow> = sqlx::query_as(
            "SELECT ulid, name, quantity, unit, barcode, done, \
             CAST(deleted_at IS NOT NULL AS SIGNED) AS deleted, rev \
             FROM shopping_items WHERE ulid = ? AND user_id = ? FOR UPDATE",
        )
        .bind(&new.ulid)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(cur) = current {
            if assumed_rev != Some(cur.rev) {
                // Stale write — reject and hand back the current master state.
                // Dropping `tx` rolls back (only a SELECT ran), releasing the lock.
                conflicts.push(cur.into());
                continue;
            }
            let rev = next_rev(&mut tx).await?;
            sqlx::query(
                "UPDATE shopping_items SET name = ?, quantity = ?, unit = ?, barcode = ?, \
                 done = ?, deleted_at = IF(?, COALESCE(deleted_at, NOW()), NULL), \
                 rev = ?, updated_at = NOW() WHERE ulid = ? AND user_id = ?",
            )
            .bind(&new.name)
            .bind(new.quantity)
            .bind(&new.unit)
            .bind(&new.barcode)
            .bind(new.done)
            .bind(new.deleted)
            .bind(rev)
            .bind(&new.ulid)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        } else {
            let rev = next_rev(&mut tx).await?;
            sqlx::query(
                "INSERT INTO shopping_items \
                 (user_id, ulid, name, quantity, unit, barcode, done, deleted_at, rev, \
                  created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, IF(?, NOW(), NULL), ?, NOW(), NOW())",
            )
            .bind(user_id)
            .bind(&new.ulid)
            .bind(&new.name)
            .bind(new.quantity)
            .bind(&new.unit)
            .bind(&new.barcode)
            .bind(new.done)
            .bind(new.deleted)
            .bind(rev)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
    }
    Ok(conflicts)
}
