//! Shared application state.

use std::sync::Arc;

use sqlx::MySqlPool;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub pool: MySqlPool,
    pub cfg: Arc<Config>,
}

impl AppState {
    pub fn new(pool: MySqlPool, cfg: Config) -> Self {
        Self {
            pool,
            cfg: Arc::new(cfg),
        }
    }
}
