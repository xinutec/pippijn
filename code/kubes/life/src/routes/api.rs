//! Authenticated API surface. Grows the inventory/recipe/3D endpoints later;
//! for now just identity echo + NC link status.

use anyhow::Context;
use axum::Json;
use axum::extract::State;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::error::AppError;
use crate::nextcloud::credentials::{self, LinkStatus};
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
    pub nextcloud: LinkStatus,
}

/// GET /api/me → who am I, and is the calendar (CalDAV) link active.
pub async fn me(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Me>, AppError> {
    let nextcloud = credentials::status(&app.pool, &user.user_id).await?;
    Ok(Json(Me {
        avatar_url: format!("{}/avatar/{}/64", app.cfg.nc_base_url, user.user_id),
        user_id: user.user_id,
        display_name: user.display_name,
        nextcloud,
    }))
}

/// GET /api/house → the house geometry scene (scenes/house.json by default).
pub async fn house(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
) -> Result<Json<Value>, AppError> {
    let text = tokio::fs::read_to_string(&app.cfg.house_scene)
        .await
        .map_err(|_| AppError::NotFound)?;
    let scene: Value = serde_json::from_str(&text).context("parsing house scene")?;
    Ok(Json(scene))
}
