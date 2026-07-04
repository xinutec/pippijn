//! coach — periodized training tracker + pacing coach. Entry point: load
//! config, connect the DB, run migrations, serve. All logic lives in the
//! `coach` library crate.

use anyhow::Result;
use coach::{config::Config, db, routes, state::AppState};
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

    // Reap abandoned sessions hourly (the first tick fires immediately, so
    // boot also sweeps). Expiry is otherwise only enforced lazily, when the
    // same cookie is presented again.
    let sweep_pool = pool.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            tick.tick().await;
            match coach::session::sweep_expired(&sweep_pool).await {
                Ok(n) if n > 0 => tracing::info!("swept {n} expired session(s)"),
                Ok(_) => {}
                Err(e) => tracing::warn!("session sweep failed: {e:#}"),
            }
        }
    });

    // Bound every outbound call (Nextcloud identity) so a hung upstream can't
    // tie up the pod.
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let bind_addr = cfg.bind_addr.clone();
    let app = routes::router(AppState::new(pool, cfg, http));

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("coach listening on {bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
