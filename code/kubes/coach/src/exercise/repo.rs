//! Exercise catalog queries. The catalog is global (not per-user).
//! SQL is written as `&'static str` literals (sqlx 0.9's SqlSafeStr guard);
//! no user data is ever interpolated into a query string. Enum columns are read
//! as strings (ExerciseRow) and converted, and written via `as_db()`.

use anyhow::{Result, anyhow};
use sqlx::MySqlPool;

use super::types::{Exercise, ExercisePatch, ExerciseRow, NewExercise};

pub async fn list(pool: &MySqlPool, include_inactive: bool) -> Result<Vec<Exercise>> {
    let q = if include_inactive {
        sqlx::query_as::<_, ExerciseRow>(
            "SELECT id, slug, name, equipment, pattern, metric, unilateral, is_active \
             FROM exercises ORDER BY pattern, name",
        )
    } else {
        sqlx::query_as::<_, ExerciseRow>(
            "SELECT id, slug, name, equipment, pattern, metric, unilateral, is_active \
             FROM exercises WHERE is_active = 1 ORDER BY pattern, name",
        )
    };
    q.fetch_all(pool)
        .await?
        .into_iter()
        .map(Exercise::try_from)
        .collect()
}

pub async fn get(pool: &MySqlPool, id: i64) -> Result<Option<Exercise>> {
    sqlx::query_as::<_, ExerciseRow>(
        "SELECT id, slug, name, equipment, pattern, metric, unilateral, is_active \
         FROM exercises WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .map(Exercise::try_from)
    .transpose()
}

/// Slug from a display name: lowercase, non-alnum → `_`, collapsed. Empty falls
/// back to `exercise`. Uniqueness is enforced by the caller's collision retry.
fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut prev_us = false;
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            s.push(ch);
            prev_us = false;
        } else if !prev_us {
            s.push('_');
            prev_us = true;
        }
    }
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "exercise".to_string()
    } else {
        s
    }
}

pub async fn create(pool: &MySqlPool, e: &NewExercise) -> Result<Exercise> {
    let base = slugify(&e.name);
    // A handful of custom exercises will never collide more than a few times;
    // try base, then base_2, base_3, … until the unique slug insert succeeds.
    for attempt in 1..=50 {
        let slug = if attempt == 1 {
            base.clone()
        } else {
            format!("{base}_{attempt}")
        };
        let res = sqlx::query(
            "INSERT INTO exercises (slug, name, equipment, pattern, metric, unilateral) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&slug)
        .bind(&e.name)
        .bind(e.equipment.as_db())
        .bind(e.pattern.as_db())
        .bind(e.metric.as_db())
        .bind(e.unilateral)
        .execute(pool)
        .await;
        match res {
            Ok(r) => {
                return get(pool, r.last_insert_id() as i64)
                    .await?
                    .ok_or_else(|| anyhow!("exercise vanished after insert"));
            }
            // 23000 = integrity constraint violation (dup slug): try the next suffix.
            Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23000") => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(anyhow!("could not allocate a unique slug for {:?}", e.name))
}

pub async fn patch(pool: &MySqlPool, id: i64, p: &ExercisePatch) -> Result<Option<Exercise>> {
    // COALESCE(?, col) leaves the column unchanged when the bind is NULL, so one
    // statement handles any subset of fields.
    sqlx::query(
        "UPDATE exercises SET \
           name = COALESCE(?, name), \
           equipment = COALESCE(?, equipment), \
           pattern = COALESCE(?, pattern), \
           metric = COALESCE(?, metric), \
           unilateral = COALESCE(?, unilateral), \
           is_active = COALESCE(?, is_active), \
           updated_at = NOW() \
         WHERE id = ?",
    )
    .bind(&p.name)
    .bind(p.equipment.map(|e| e.as_db()))
    .bind(p.pattern.map(|e| e.as_db()))
    .bind(p.metric.map(|e| e.as_db()))
    .bind(p.unilateral)
    .bind(p.is_active)
    .bind(id)
    .execute(pool)
    .await?;
    get(pool, id).await
}
