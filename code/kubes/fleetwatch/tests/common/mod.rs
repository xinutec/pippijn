//! Shared DB-test setup.
//!
//! Each `#[tokio::test]` runs on its OWN runtime, so a pool can't be shared
//! across tests — connections created on one test's runtime die when that
//! runtime shuts down, and a later test using them just hangs. So every test
//! gets its own pool. To keep that safe on a shared database we serialize the DB
//! tests behind one lock: it makes the (idempotent) migrations run one at a time
//! rather than racing, and stops a test that asserts on the *global*
//! `overview`/`problems` queries from overlapping another test's inserts.
//!
//! Returns `None` when FLEETWATCH_TEST_DATABASE_URL is unset, so DB tests skip cleanly
//! and the default `cargo test` needs no database.

use sqlx::MySqlPool;
use tokio::sync::{Mutex, MutexGuard};
use fleetwatch::db;

static LOCK: Mutex<()> = Mutex::const_new(());

/// Acquire exclusive DB access, connect + migrate, wipe `source`'s rows, and
/// hand back a fresh pool + the guard. Keep the guard alive for the whole test
/// (`let (pool, _guard) = …`) so the DB tests stay serialized.
pub async fn setup(source: &str) -> Option<(MySqlPool, MutexGuard<'static, ()>)> {
    let url = std::env::var("FLEETWATCH_TEST_DATABASE_URL").ok()?;
    let guard = LOCK.lock().await;
    let pool = db::connect(&url).await.expect("connect test DB");
    db::migrate(&pool).await.expect("migrate test DB");
    clean(&pool, source).await;
    Some((pool, guard))
}

/// Delete every report (and, via cascade, check) for one test's isolated source.
pub async fn clean(pool: &MySqlPool, source: &str) {
    sqlx::query("DELETE FROM report WHERE source = ?")
        .bind(source)
        .execute(pool)
        .await
        .unwrap();
}
