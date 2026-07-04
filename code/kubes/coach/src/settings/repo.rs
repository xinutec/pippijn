//! Settings queries. A missing row means "defaults"; the first PATCH upserts.

use anyhow::Result;
use sqlx::MySqlPool;

use super::types::{Settings, SettingsPatch};

/// Current settings, or defaults if the user has never saved any.
pub async fn get(pool: &MySqlPool, user_id: &str) -> Result<Settings> {
    let row = sqlx::query_as::<_, Settings>(
        "SELECT timezone, window_start_hour, window_end_hour, night_cutoff_hour, min_rest_min \
         FROM settings WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.unwrap_or_default())
}

/// Apply a patch over the current (or default) settings and upsert the row.
pub async fn upsert(pool: &MySqlPool, user_id: &str, p: &SettingsPatch) -> Result<Settings> {
    let mut s = get(pool, user_id).await?;
    if let Some(v) = &p.timezone {
        s.timezone = v.clone();
    }
    if let Some(v) = p.window_start_hour {
        s.window_start_hour = v;
    }
    if let Some(v) = p.window_end_hour {
        s.window_end_hour = v;
    }
    if let Some(v) = p.night_cutoff_hour {
        s.night_cutoff_hour = v;
    }
    if let Some(v) = p.min_rest_min {
        s.min_rest_min = v;
    }
    sqlx::query(
        "INSERT INTO settings \
           (user_id, timezone, window_start_hour, window_end_hour, night_cutoff_hour, min_rest_min, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, NOW()) \
         ON DUPLICATE KEY UPDATE \
           timezone = VALUES(timezone), \
           window_start_hour = VALUES(window_start_hour), \
           window_end_hour = VALUES(window_end_hour), \
           night_cutoff_hour = VALUES(night_cutoff_hour), \
           min_rest_min = VALUES(min_rest_min), \
           updated_at = NOW()",
    )
    .bind(user_id)
    .bind(&s.timezone)
    .bind(s.window_start_hour)
    .bind(s.window_end_hour)
    .bind(s.night_cutoff_hour)
    .bind(s.min_rest_min)
    .execute(pool)
    .await?;
    Ok(s)
}
