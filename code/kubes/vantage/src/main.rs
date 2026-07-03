//! vantage — fleet monitoring platform backend. Entry point: load config, connect
//! the DB, run migrations, start the retention sweeper, serve. All logic lives
//! in the `vantage` library crate.

use anyhow::Result;
use vantage::{config::Config, db, report::retention, routes, state::AppState};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.database_url).await?;
    db::migrate(&pool).await?;

    // Daily retention sweep (the first tick fires immediately, so boot also
    // sweeps). Prunes raw payloads early and old checks; report summaries stay.
    let sweep_pool = pool.clone();
    let (raw_days, check_days) = (cfg.raw_retention_days, cfg.check_retention_days);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(24 * 3600));
        loop {
            tick.tick().await;
            match retention::sweep(&sweep_pool, raw_days, check_days).await {
                Ok((raw, checks)) if raw > 0 || checks > 0 => {
                    tracing::info!("retention: cleared {raw} raw payload(s), {checks} old check(s)")
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("retention sweep failed: {e:#}"),
            }
        }
    });

    let bind_addr = cfg.bind_addr.clone();
    let app = routes::router(AppState::new(pool, cfg));

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("vantage listening on {bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
