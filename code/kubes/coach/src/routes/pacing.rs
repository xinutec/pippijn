//! Pacing endpoint. The Android nudge and the Today view both read this.

use axum::Json;
use axum::extract::State;

use crate::error::AppError;
use crate::pacing::service;
use crate::pacing::types::PacingNow;
use crate::session::AuthUser;
use crate::state::AppState;

/// GET /api/pacing/now → the current pacing verdict (what to do, whether to nudge).
pub async fn now(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<PacingNow>, AppError> {
    Ok(Json(service::now(&app.pool, &user.user_id).await?))
}
