//! life — personal home OS backend. Entry point: load config, connect the DB,
//! run migrations, serve. All logic lives in the `life` library crate.

use anyhow::Result;
use life::{config::Config, db, routes, state::AppState, sync};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    if cfg.dev_login_user.is_some() {
        tracing::warn!(
            "DEV_LOGIN_USER is set — /dev-login mints sessions without Nextcloud. \
             NEVER set this in production."
        );
    }
    let pool = db::connect(&cfg.database_url).await?;
    db::migrate(&pool).await?;
    sync::backfill(&pool).await?;

    let http = reqwest::Client::builder().build()?;
    let bind_addr = cfg.bind_addr.clone();
    let app = routes::router(AppState::new(pool, cfg, http));

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("life listening on {bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
