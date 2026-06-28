//! Authenticated API surface. Grows the inventory/recipe/3D endpoints later;
//! for now just identity echo + NC link status.

use anyhow::Context;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

use crate::error::AppError;
use crate::nextcloud::credentials;
use crate::session::AuthUser;
use crate::state::AppState;

/// GET /api/me → who am I, and is the calendar (CalDAV) link active.
pub async fn me(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, AppError> {
    let nextcloud = credentials::status(&app.pool, &user.user_id).await?;
    Ok(Json(json!({
        "userId": user.user_id,
        "displayName": user.display_name,
        "nextcloud": nextcloud,
    })))
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
