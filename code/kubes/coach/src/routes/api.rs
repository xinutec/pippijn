//! Authenticated API surface. Grows the exercise / program / set-logging and
//! pacing endpoints later; for now just the identity echo.

use axum::Json;
use axum::extract::State;
use serde::Serialize;
use ts_rs::TS;

use crate::error::AppError;
use crate::session::AuthUser;
use crate::state::AppState;

/// Identity echo for /api/me. A typed struct (not a hand-built json!) so the
/// TS shape is generated, not transcribed.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Me {
    pub user_id: String,
    pub display_name: String,
    /// NC serves avatars publicly, so the SPA can load this cross-origin.
    pub avatar_url: String,
}

/// GET /api/me → who am I.
pub async fn me(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Me>, AppError> {
    Ok(Json(Me {
        avatar_url: format!("{}/avatar/{}/64", app.cfg.nc_base_url, user.user_id),
        user_id: user.user_id,
        display_name: user.display_name,
    }))
}
