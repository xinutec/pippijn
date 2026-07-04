//! MariaDB connection pool. coach's own database — NC is never written to.

use anyhow::{Context, Result};
use sqlx::MySqlPool;
use sqlx::mysql::MySqlPoolOptions;

pub async fn connect(database_url: &str) -> Result<MySqlPool> {
    let pool = MySqlPoolOptions::new()
        .max_connections(8)
        .connect(database_url)
        .await
        .context("connecting to MariaDB")?;
    Ok(pool)
}

/// Apply embedded migrations from `migrations/`. Idempotent; safe on every boot.
pub async fn migrate(pool: &MySqlPool) -> Result<()> {
    sqlx::migrate!()
        .run(pool)
        .await
        .context("running migrations")?;
    Ok(())
}
