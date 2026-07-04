//! Workout-set queries. Soft-deletes (deleted_at) so history stays intact.
//! SQL is `&'static str` literal (sqlx 0.9 SqlSafeStr); no interpolation.

use anyhow::{Result, anyhow};
use chrono::NaiveDateTime;
use sqlx::MySqlPool;

use super::types::{NewSet, WorkoutSet};

/// Insert a logged set. `program_id` is the active program at log time (or None
/// for an off-program set). `logged_at` defaults to now when the client omits it.
pub async fn create(
    pool: &MySqlPool,
    user_id: &str,
    program_id: Option<i64>,
    n: &NewSet,
) -> Result<WorkoutSet> {
    let res = sqlx::query(
        // logged_at defaults to UTC (UTC_TIMESTAMP), so the pacing engine's
        // local-tz day/window math is correct regardless of server tz.
        "INSERT INTO workout_sets \
           (user_id, exercise_id, program_id, logged_at, reps, load_kg, hold_s, rpe, note) \
         VALUES (?, ?, ?, COALESCE(?, UTC_TIMESTAMP()), ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(n.exercise_id)
    .bind(program_id)
    .bind(n.logged_at)
    .bind(n.reps)
    .bind(n.load_kg)
    .bind(n.hold_s)
    .bind(n.rpe)
    .bind(&n.note)
    .execute(pool)
    .await?;
    get(pool, user_id, res.last_insert_id() as i64)
        .await?
        .ok_or_else(|| anyhow!("set vanished after insert"))
}

pub async fn get(pool: &MySqlPool, user_id: &str, id: i64) -> Result<Option<WorkoutSet>> {
    Ok(sqlx::query_as::<_, WorkoutSet>(
        "SELECT id, exercise_id, program_id, logged_at, reps, load_kg, hold_s, rpe, note \
         FROM workout_sets WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?)
}

/// Most-recent sets first, capped at `limit`.
pub async fn list_recent(pool: &MySqlPool, user_id: &str, limit: i64) -> Result<Vec<WorkoutSet>> {
    Ok(sqlx::query_as::<_, WorkoutSet>(
        "SELECT id, exercise_id, program_id, logged_at, reps, load_kg, hold_s, rpe, note \
         FROM workout_sets WHERE user_id = ? AND deleted_at IS NULL \
         ORDER BY logged_at DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

/// All live sets logged at or after `since`, oldest first. Feeds the pacing
/// engine's weekly/daily burn-down.
pub async fn list_since(
    pool: &MySqlPool,
    user_id: &str,
    since: NaiveDateTime,
) -> Result<Vec<WorkoutSet>> {
    Ok(sqlx::query_as::<_, WorkoutSet>(
        "SELECT id, exercise_id, program_id, logged_at, reps, load_kg, hold_s, rpe, note \
         FROM workout_sets WHERE user_id = ? AND deleted_at IS NULL AND logged_at >= ? \
         ORDER BY logged_at ASC",
    )
    .bind(user_id)
    .bind(since)
    .fetch_all(pool)
    .await?)
}

/// Soft-delete a set. Returns false if nothing matched (wrong user / already gone).
pub async fn soft_delete(pool: &MySqlPool, user_id: &str, id: i64) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE workout_sets SET deleted_at = NOW() \
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}
