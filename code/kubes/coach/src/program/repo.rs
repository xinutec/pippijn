//! Program / target / pin queries.
//! SQL is `&'static str` literal (sqlx 0.9 SqlSafeStr); no interpolation.

use anyhow::{Result, anyhow};
use chrono::NaiveDate;
use sqlx::MySqlPool;

use super::types::{
    GenTarget, NewPin, Program, ProgramDetail, ProgramPin, ProgramTarget, TargetPatch,
};

/// The user's current active program, if any.
pub async fn active(pool: &MySqlPool, user_id: &str) -> Result<Option<Program>> {
    Ok(sqlx::query_as::<_, Program>(
        "SELECT id, name, start_date, weeks, deload_week, active FROM programs \
         WHERE user_id = ? AND active = 1 AND deleted_at IS NULL \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn list(pool: &MySqlPool, user_id: &str) -> Result<Vec<Program>> {
    Ok(sqlx::query_as::<_, Program>(
        "SELECT id, name, start_date, weeks, deload_week, active FROM programs \
         WHERE user_id = ? AND deleted_at IS NULL \
         ORDER BY start_date DESC, id DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?)
}

pub async fn get(pool: &MySqlPool, user_id: &str, id: i64) -> Result<Option<Program>> {
    Ok(sqlx::query_as::<_, Program>(
        "SELECT id, name, start_date, weeks, deload_week, active FROM programs \
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn targets(pool: &MySqlPool, program_id: i64) -> Result<Vec<ProgramTarget>> {
    Ok(sqlx::query_as::<_, ProgramTarget>(
        "SELECT id, exercise_id, week_index, target_sets, rep_low, rep_high, load_kg, hold_s \
         FROM program_targets WHERE program_id = ? ORDER BY week_index, exercise_id",
    )
    .bind(program_id)
    .fetch_all(pool)
    .await?)
}

pub async fn pins(pool: &MySqlPool, program_id: i64) -> Result<Vec<ProgramPin>> {
    Ok(sqlx::query_as::<_, ProgramPin>(
        "SELECT id, exercise_id, weekday, sets FROM program_pins \
         WHERE program_id = ? ORDER BY weekday, exercise_id",
    )
    .bind(program_id)
    .fetch_all(pool)
    .await?)
}

/// A program plus its full targets and pins. None if not found / not owned.
pub async fn detail(pool: &MySqlPool, user_id: &str, id: i64) -> Result<Option<ProgramDetail>> {
    let Some(program) = get(pool, user_id, id).await? else {
        return Ok(None);
    };
    Ok(Some(ProgramDetail {
        targets: targets(pool, id).await?,
        pins: pins(pool, id).await?,
        program,
    }))
}

/// Create a program with its generated targets, making it the sole active one.
/// Deactivating the previous program(s) + the inserts run in one transaction.
pub async fn create(
    pool: &MySqlPool,
    user_id: &str,
    name: &str,
    start_date: NaiveDate,
    weeks: i32,
    deload_week: Option<i32>,
    gens: &[GenTarget],
) -> Result<ProgramDetail> {
    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE programs SET active = 0, updated_at = NOW() WHERE user_id = ? AND active = 1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    let res = sqlx::query(
        "INSERT INTO programs (user_id, name, start_date, weeks, deload_week, active) \
         VALUES (?, ?, ?, ?, ?, 1)",
    )
    .bind(user_id)
    .bind(name)
    .bind(start_date)
    .bind(weeks)
    .bind(deload_week)
    .execute(&mut *tx)
    .await?;
    let program_id = res.last_insert_id() as i64;

    for g in gens {
        sqlx::query(
            "INSERT INTO program_targets \
               (program_id, exercise_id, week_index, target_sets, rep_low, rep_high, load_kg, hold_s) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(program_id)
        .bind(g.exercise_id)
        .bind(g.week_index)
        .bind(g.target_sets)
        .bind(g.rep_low)
        .bind(g.rep_high)
        .bind(g.load_kg)
        .bind(g.hold_s)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    detail(pool, user_id, program_id)
        .await?
        .ok_or_else(|| anyhow!("program vanished after insert"))
}

/// Make `id` the user's sole active program. False if it isn't theirs.
pub async fn set_active(pool: &MySqlPool, user_id: &str, id: i64) -> Result<bool> {
    if get(pool, user_id, id).await?.is_none() {
        return Ok(false);
    }
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE programs SET active = 0, updated_at = NOW() WHERE user_id = ? AND active = 1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE programs SET active = 1, updated_at = NOW() WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

/// Edit one target's numbers. Ownership enforced via the parent program's user.
pub async fn patch_target(
    pool: &MySqlPool,
    user_id: &str,
    target_id: i64,
    p: &TargetPatch,
) -> Result<Option<ProgramTarget>> {
    sqlx::query(
        "UPDATE program_targets t \
         JOIN programs pr ON pr.id = t.program_id \
         SET t.target_sets = COALESCE(?, t.target_sets), \
             t.rep_low  = COALESCE(?, t.rep_low), \
             t.rep_high = COALESCE(?, t.rep_high), \
             t.load_kg  = COALESCE(?, t.load_kg), \
             t.hold_s   = COALESCE(?, t.hold_s) \
         WHERE t.id = ? AND pr.user_id = ?",
    )
    .bind(p.target_sets)
    .bind(p.rep_low)
    .bind(p.rep_high)
    .bind(p.load_kg)
    .bind(p.hold_s)
    .bind(target_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    // Read back (an unowned target simply returns None; an identical-value edit
    // affects 0 rows but still resolves to the current row).
    get_target(pool, user_id, target_id).await
}

async fn get_target(
    pool: &MySqlPool,
    user_id: &str,
    target_id: i64,
) -> Result<Option<ProgramTarget>> {
    Ok(sqlx::query_as::<_, ProgramTarget>(
        "SELECT t.id, t.exercise_id, t.week_index, t.target_sets, t.rep_low, t.rep_high, \
                t.load_kg, t.hold_s \
         FROM program_targets t JOIN programs pr ON pr.id = t.program_id \
         WHERE t.id = ? AND pr.user_id = ?",
    )
    .bind(target_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?)
}

/// Upsert a day pin (one row per program+exercise+weekday). None if the program
/// isn't the user's.
pub async fn upsert_pin(
    pool: &MySqlPool,
    user_id: &str,
    program_id: i64,
    n: &NewPin,
) -> Result<Option<ProgramPin>> {
    if get(pool, user_id, program_id).await?.is_none() {
        return Ok(None);
    }
    sqlx::query(
        "INSERT INTO program_pins (program_id, exercise_id, weekday, sets) \
         VALUES (?, ?, ?, ?) \
         ON DUPLICATE KEY UPDATE sets = VALUES(sets)",
    )
    .bind(program_id)
    .bind(n.exercise_id)
    .bind(n.weekday)
    .bind(n.sets)
    .execute(pool)
    .await?;
    Ok(sqlx::query_as::<_, ProgramPin>(
        "SELECT id, exercise_id, weekday, sets FROM program_pins \
         WHERE program_id = ? AND exercise_id = ? AND weekday = ?",
    )
    .bind(program_id)
    .bind(n.exercise_id)
    .bind(n.weekday)
    .fetch_optional(pool)
    .await?)
}

/// Delete a pin. False if not found / not owned.
pub async fn delete_pin(
    pool: &MySqlPool,
    user_id: &str,
    program_id: i64,
    pin_id: i64,
) -> Result<bool> {
    let res = sqlx::query(
        "DELETE p FROM program_pins p \
         JOIN programs pr ON pr.id = p.program_id \
         WHERE p.id = ? AND p.program_id = ? AND pr.user_id = ?",
    )
    .bind(pin_id)
    .bind(program_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}
