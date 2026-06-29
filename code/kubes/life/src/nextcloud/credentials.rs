//! Store for the NC app password (Login Flow v2 result), in life's own DB.
//! Single credential per user; no expiry, no refresh.

use anyhow::Result;
use sqlx::MySqlPool;
use ts_rs::TS;

use crate::nextcloud::login_flow::AppPassword;

#[derive(Debug, PartialEq, Eq, serde::Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "ConnectionStatus")]
pub enum LinkStatus {
    Active,
    NeedsReauth,
    NotLinked,
}

/// Upsert the app password granted via Login Flow v2.
pub async fn store(pool: &MySqlPool, user_id: &str, creds: &AppPassword) -> Result<()> {
    sqlx::query(
        "INSERT INTO nc_credentials (user_id, login_name, app_password, status) \
         VALUES (?, ?, ?, 'active') \
         ON DUPLICATE KEY UPDATE login_name = VALUES(login_name), \
         app_password = VALUES(app_password), status = 'active'",
    )
    .bind(user_id)
    .bind(&creds.login_name)
    .bind(&creds.app_password)
    .execute(pool)
    .await?;
    Ok(())
}

/// Cheap status read for /api/me — no NC round-trip.
pub async fn status(pool: &MySqlPool, user_id: &str) -> Result<LinkStatus> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT status FROM nc_credentials WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    let status = row.map(|(s,)| s);
    Ok(match status.as_deref() {
        Some("active") => LinkStatus::Active,
        Some(_) => LinkStatus::NeedsReauth,
        None => LinkStatus::NotLinked,
    })
}
