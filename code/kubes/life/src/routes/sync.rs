//! HTTP surface for the offline-first sync protocol (RxDB pull/push). Shopping
//! first; other collections follow the same shape.

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;

use crate::error::AppError;
use crate::session::AuthUser;
use crate::state::AppState;
use crate::sync::repo;
use crate::sync::types::{PullResponse, PushEntry, ShoppingDoc};

#[derive(Debug, Deserialize)]
pub struct PullQuery {
    /// Highest `rev` already seen (the checkpoint). Defaults to 0 (full pull).
    #[serde(default)]
    since: u64,
    #[serde(default = "default_limit")]
    limit: u64,
}

fn default_limit() -> u64 {
    200
}

/// GET /api/sync/shopping?since=<rev>&limit=<n>
pub async fn pull_shopping(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<PullQuery>,
) -> Result<Json<PullResponse>, AppError> {
    let limit = q.limit.clamp(1, 1000);
    Ok(Json(
        repo::pull_shopping(&app.pool, &user.user_id, q.since, limit).await?,
    ))
}

/// POST /api/sync/shopping — body: array of `{newDocumentState, assumedMasterState}`.
/// Returns the current server doc for each rejected (stale) change.
pub async fn push_shopping(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(entries): Json<Vec<PushEntry>>,
) -> Result<Json<Vec<ShoppingDoc>>, AppError> {
    Ok(Json(
        repo::push_shopping(&app.pool, &user.user_id, entries).await?,
    ))
}
