//! Pacing-settings endpoints.

use axum::Json;
use axum::extract::State;

use crate::error::AppError;
use crate::session::AuthUser;
use crate::settings::repo;
use crate::settings::types::{Settings, SettingsPatch};
use crate::state::AppState;

/// GET /api/settings → current settings (defaults if never saved).
pub async fn get(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Settings>, AppError> {
    Ok(Json(repo::get(&app.pool, &user.user_id).await?))
}

/// PATCH /api/settings → update the active window / cutoff / spacing.
pub async fn patch(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<SettingsPatch>,
) -> Result<Json<Settings>, AppError> {
    Ok(Json(repo::upsert(&app.pool, &user.user_id, &body).await?))
}
