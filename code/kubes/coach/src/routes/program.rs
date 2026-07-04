//! Program (mesocycle) endpoints: the starter generator, activation, and
//! editing of targets + day pins.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::error::AppError;
use crate::exercise::repo as exercise_repo;
use crate::program::repo;
use crate::program::starter;
use crate::program::types::{
    NewPin, Program, ProgramDetail, ProgramPin, ProgramTarget, StarterRequest, TargetPatch,
};
use crate::session::AuthUser;
use crate::state::AppState;

/// GET /api/programs → all of the user's programs (newest first).
pub async fn list(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<Program>>, AppError> {
    Ok(Json(repo::list(&app.pool, &user.user_id).await?))
}

/// GET /api/programs/active → the active program with its targets + pins, or null.
pub async fn active(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Option<ProgramDetail>>, AppError> {
    let Some(p) = repo::active(&app.pool, &user.user_id).await? else {
        return Ok(Json(None));
    };
    Ok(Json(repo::detail(&app.pool, &user.user_id, p.id).await?))
}

/// GET /api/programs/{id} → one program with targets + pins.
pub async fn detail(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<ProgramDetail>, AppError> {
    repo::detail(&app.pool, &user.user_id, id)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

/// POST /api/programs/starter → generate the seeded 4-week block and activate it.
pub async fn create_starter(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<StarterRequest>,
) -> Result<Json<ProgramDetail>, AppError> {
    let start = body.start_date.unwrap_or_else(starter::current_week_monday);
    let catalog: HashMap<String, i64> = exercise_repo::list(&app.pool, true)
        .await?
        .into_iter()
        .map(|e| (e.slug, e.id))
        .collect();
    let gens = starter::generate(
        &catalog,
        starter::STARTER_WEEKS,
        Some(starter::STARTER_DELOAD_WEEK),
    );
    let detail = repo::create(
        &app.pool,
        &user.user_id,
        starter::STARTER_NAME,
        start,
        starter::STARTER_WEEKS,
        Some(starter::STARTER_DELOAD_WEEK),
        &gens,
    )
    .await?;
    Ok(Json(detail))
}

/// POST /api/programs/{id}/activate → make it the sole active program.
pub async fn activate(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    if repo::set_active(&app.pool, &user.user_id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}

/// PATCH /api/program-targets/{id} → edit one week's numbers for an exercise.
pub async fn patch_target(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<TargetPatch>,
) -> Result<Json<ProgramTarget>, AppError> {
    repo::patch_target(&app.pool, &user.user_id, id, &body)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

/// POST /api/programs/{id}/pins → pin some sets of an exercise to a weekday.
pub async fn upsert_pin(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(program_id): Path<i64>,
    Json(body): Json<NewPin>,
) -> Result<Json<ProgramPin>, AppError> {
    repo::upsert_pin(&app.pool, &user.user_id, program_id, &body)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

/// DELETE /api/programs/{id}/pins/{pinId} → remove a day pin.
pub async fn delete_pin(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path((program_id, pin_id)): Path<(i64, i64)>,
) -> Result<StatusCode, AppError> {
    if repo::delete_pin(&app.pool, &user.user_id, program_id, pin_id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}
