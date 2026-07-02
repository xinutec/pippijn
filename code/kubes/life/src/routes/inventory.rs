//! Inventory HTTP surface: the location tree, items, and moves.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;

use crate::error::AppError;
use crate::inventory::repo;
use crate::inventory::types::{Item, Location, NewItem, NewLocation};
use crate::session::AuthUser;
use crate::state::AppState;

pub async fn list_locations(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<Location>>, AppError> {
    Ok(Json(repo::list_locations(&app.pool, &user.user_id).await?))
}

pub async fn create_location(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewLocation>,
) -> Result<Json<Location>, AppError> {
    Ok(Json(
        repo::create_location(&app.pool, &user.user_id, body).await?,
    ))
}

pub async fn list_items(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<Item>>, AppError> {
    Ok(Json(repo::list_items(&app.pool, &user.user_id).await?))
}

pub async fn create_item(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewItem>,
) -> Result<Json<Item>, AppError> {
    Ok(Json(
        repo::create_item(&app.pool, &user.user_id, body).await?,
    ))
}

#[derive(Deserialize)]
pub struct MoveBody {
    pub location_id: Option<u64>,
}

pub async fn update_item(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
    Json(body): Json<NewItem>,
) -> Result<Json<Item>, AppError> {
    repo::update_item(&app.pool, &user.user_id, id, body)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

pub async fn delete_item(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
) -> Result<StatusCode, AppError> {
    if repo::delete_item(&app.pool, &user.user_id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn delete_location(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
) -> Result<StatusCode, AppError> {
    if repo::delete_location(&app.pool, &user.user_id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn move_item(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
    Json(body): Json<MoveBody>,
) -> Result<Json<Item>, AppError> {
    repo::move_item(&app.pool, &user.user_id, id, body.location_id)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}
