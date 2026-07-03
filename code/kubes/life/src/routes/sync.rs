//! HTTP surface for the offline-first sync protocol (RxDB pull/push). One
//! pull/push pair per collection (shopping, to-do); they share the generic
//! envelope and the same shape.

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;

use crate::error::AppError;
use crate::session::AuthUser;
use crate::state::AppState;
use crate::sync::repo;
use crate::sync::types::{
    PullResponse, PushEntry, ShoppingDoc, TodoDoc, TodoLinkDoc, WellbeingDoc,
};

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
) -> Result<Json<PullResponse<ShoppingDoc>>, AppError> {
    let limit = q.limit.clamp(1, 1000);
    let res = repo::pull_shopping(&app.pool, &user.user_id, q.since, limit).await?;
    tracing::debug!(
        user = %user.user_id,
        since = q.since,
        returned = res.documents.len(),
        checkpoint = res.checkpoint.rev,
        "sync pull shopping"
    );
    Ok(Json(res))
}

/// POST /api/sync/shopping — body: array of `{newDocumentState, assumedMasterState}`.
/// Returns the current server doc for each rejected (stale) change.
pub async fn push_shopping(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(entries): Json<Vec<PushEntry<ShoppingDoc>>>,
) -> Result<Json<Vec<ShoppingDoc>>, AppError> {
    let pushed = entries.len();
    let conflicts = repo::push_shopping(&app.pool, &user.user_id, entries).await?;
    tracing::debug!(user = %user.user_id, pushed, conflicts = conflicts.len(), "sync push shopping");
    Ok(Json(conflicts))
}

/// GET /api/sync/todo?since=<rev>&limit=<n>
pub async fn pull_todo(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<PullQuery>,
) -> Result<Json<PullResponse<TodoDoc>>, AppError> {
    let limit = q.limit.clamp(1, 1000);
    let res = repo::pull_todo(&app.pool, &user.user_id, q.since, limit).await?;
    tracing::debug!(
        user = %user.user_id,
        since = q.since,
        returned = res.documents.len(),
        checkpoint = res.checkpoint.rev,
        "sync pull todo"
    );
    Ok(Json(res))
}

/// POST /api/sync/todo — body: array of `{newDocumentState, assumedMasterState}`.
pub async fn push_todo(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(entries): Json<Vec<PushEntry<TodoDoc>>>,
) -> Result<Json<Vec<TodoDoc>>, AppError> {
    let pushed = entries.len();
    let conflicts = repo::push_todo(&app.pool, &user.user_id, entries).await?;
    tracing::debug!(user = %user.user_id, pushed, conflicts = conflicts.len(), "sync push todo");
    Ok(Json(conflicts))
}

/// GET /api/sync/todo-link?since=<rev>&limit=<n>
pub async fn pull_todo_link(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<PullQuery>,
) -> Result<Json<PullResponse<TodoLinkDoc>>, AppError> {
    let limit = q.limit.clamp(1, 1000);
    let res = repo::pull_todo_link(&app.pool, &user.user_id, q.since, limit).await?;
    tracing::debug!(
        user = %user.user_id,
        since = q.since,
        returned = res.documents.len(),
        checkpoint = res.checkpoint.rev,
        "sync pull todo-link"
    );
    Ok(Json(res))
}

/// POST /api/sync/todo-link — body: array of `{newDocumentState, assumedMasterState}`.
pub async fn push_todo_link(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(entries): Json<Vec<PushEntry<TodoLinkDoc>>>,
) -> Result<Json<Vec<TodoLinkDoc>>, AppError> {
    let pushed = entries.len();
    let conflicts = repo::push_todo_link(&app.pool, &user.user_id, entries).await?;
    tracing::debug!(user = %user.user_id, pushed, conflicts = conflicts.len(), "sync push todo-link");
    Ok(Json(conflicts))
}

/// GET /api/sync/wellbeing?since=<rev>&limit=<n>
pub async fn pull_wellbeing(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<PullQuery>,
) -> Result<Json<PullResponse<WellbeingDoc>>, AppError> {
    let limit = q.limit.clamp(1, 1000);
    let res = repo::pull_wellbeing(&app.pool, &user.user_id, q.since, limit).await?;
    tracing::debug!(
        user = %user.user_id,
        since = q.since,
        returned = res.documents.len(),
        checkpoint = res.checkpoint.rev,
        "sync pull wellbeing"
    );
    Ok(Json(res))
}

/// POST /api/sync/wellbeing — body: array of `{newDocumentState, assumedMasterState}`.
pub async fn push_wellbeing(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(entries): Json<Vec<PushEntry<WellbeingDoc>>>,
) -> Result<Json<Vec<WellbeingDoc>>, AppError> {
    let pushed = entries.len();
    let conflicts = repo::push_wellbeing(&app.pool, &user.user_id, entries).await?;
    tracing::debug!(user = %user.user_id, pushed, conflicts = conflicts.len(), "sync push wellbeing");
    Ok(Json(conflicts))
}
