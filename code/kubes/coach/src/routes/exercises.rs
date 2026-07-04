//! Exercise catalog endpoints.

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::Deserialize;

use crate::error::AppError;
use crate::exercise::repo;
use crate::exercise::types::{Exercise, ExercisePatch, NewExercise};
use crate::session::AuthUser;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    pub include_inactive: bool,
}

/// GET /api/exercises → the catalog (active only unless includeInactive=true).
pub async fn list(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Exercise>>, AppError> {
    Ok(Json(repo::list(&app.pool, q.include_inactive).await?))
}

/// POST /api/exercises → add a custom movement.
pub async fn create(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
    Json(body): Json<NewExercise>,
) -> Result<Json<Exercise>, AppError> {
    Ok(Json(repo::create(&app.pool, &body).await?))
}

/// PATCH /api/exercises/{id} → edit / (de)activate a movement.
pub async fn patch(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<ExercisePatch>,
) -> Result<Json<Exercise>, AppError> {
    repo::patch(&app.pool, id, &body)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}
