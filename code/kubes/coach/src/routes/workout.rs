//! Workout-set (micro-log) endpoints.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;

use crate::error::AppError;
use crate::program::repo as program_repo;
use crate::session::AuthUser;
use crate::state::AppState;
use crate::workout::repo;
use crate::workout::types::{NewSet, WorkoutSet};

/// POST /api/sets → log a set. It's stamped with the active program so it burns
/// down that program's targets.
pub async fn create(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewSet>,
) -> Result<Json<WorkoutSet>, AppError> {
    let program_id = program_repo::active(&app.pool, &user.user_id)
        .await?
        .map(|p| p.id);
    Ok(Json(
        repo::create(&app.pool, &user.user_id, program_id, &body).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentQuery {
    pub limit: Option<i64>,
}

/// GET /api/sets → most-recent sets first (limit default 50, max 500).
pub async fn list(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<RecentQuery>,
) -> Result<Json<Vec<WorkoutSet>>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    Ok(Json(repo::list_recent(&app.pool, &user.user_id, limit).await?))
}

/// DELETE /api/sets/{id} → soft-delete a logged set.
pub async fn delete(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    if repo::soft_delete(&app.pool, &user.user_id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}
