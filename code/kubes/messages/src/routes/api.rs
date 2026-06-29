//! JSON API. Every route requires a valid session (the `AuthUser` extractor),
//! which in turn only exists for an allow-listed user (see routes::auth).

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};

use crate::archive;
use crate::error::AppError;
use crate::session::AuthUser;
use crate::state::AppState;

#[derive(Serialize)]
pub struct Me {
    user_id: String,
    display_name: String,
}

/// GET /api/me → the current session's user (drives the UI login gate).
pub async fn me(AuthUser(user): AuthUser) -> Json<Me> {
    Json(Me {
        user_id: user.user_id,
        display_name: user.display_name,
    })
}

/// GET /api/conversations → all conversations across both origins.
pub async fn conversations(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
) -> Result<Json<Vec<archive::Conversation>>, AppError> {
    Ok(Json(archive::list_conversations(&app.pool).await?))
}

#[derive(Deserialize)]
pub struct MessagesQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

/// GET /api/conversations/{origin}/{id}/messages → one page, oldest→newest.
pub async fn messages(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
    Path((origin, id)): Path<(String, String)>,
    Query(q): Query<MessagesQuery>,
) -> Result<Json<archive::MessagesPage>, AppError> {
    if !archive::valid_origin(&origin) {
        return Err(AppError::NotFound);
    }
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let page = archive::messages_page(&app.pool, &origin, &id, q.before, limit).await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    limit: Option<i64>,
}

/// GET /api/search?q= → substring search across both origins.
pub async fn search(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
    Query(sq): Query<SearchQuery>,
) -> Result<Json<Vec<archive::SearchHit>>, AppError> {
    let limit = sq.limit.unwrap_or(50).clamp(1, 200);
    let q = sq.q.trim();
    if q.is_empty() {
        return Ok(Json(Vec::new()));
    }
    Ok(Json(archive::search(&app.pool, q, limit).await?))
}
