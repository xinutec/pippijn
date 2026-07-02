//! Shopping-list HTTP surface, plus the buy→inventory conversion.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::error::AppError;
use crate::inventory::repo as inventory_repo;
use crate::inventory::types::{Item, ItemCategory, NewItem};
use crate::session::AuthUser;
use crate::shopping::repo;
use crate::shopping::types::{NewShoppingItem, ShoppingItem, UpdateShoppingItem};
use crate::state::AppState;

pub async fn list(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<ShoppingItem>>, AppError> {
    Ok(Json(repo::list(&app.pool, &user.user_id).await?))
}

pub async fn create(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewShoppingItem>,
) -> Result<Json<ShoppingItem>, AppError> {
    Ok(Json(repo::create(&app.pool, &user.user_id, body).await?))
}

pub async fn update(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
    Json(body): Json<UpdateShoppingItem>,
) -> Result<Json<ShoppingItem>, AppError> {
    repo::update(&app.pool, &user.user_id, id, body)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

pub async fn delete(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
) -> Result<StatusCode, AppError> {
    if repo::delete(&app.pool, &user.user_id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}

/// POST /api/shopping/{id}/buy → turn a bought item into an inventory item
/// (unplaced) and remove it from the list. Returns the item. A barcoded item
/// came from Open *Food* Facts, so it defaults to `food`; everything else to
/// `other`.
///
/// Ordering makes a double-tap idempotent: the soft-delete (guarded by
/// `rows_affected`) is the claim — only the request that actually tombstones the
/// row creates the inventory item; a concurrent duplicate 404s instead of
/// minting a second item. A crash between the two writes loses nothing
/// permanent (the shopping row is tombstoned, not gone).
pub async fn buy(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
) -> Result<Json<Item>, AppError> {
    let s = repo::get(&app.pool, &user.user_id, id)
        .await?
        .ok_or(AppError::NotFound)?;
    if !repo::delete(&app.pool, &user.user_id, id).await? {
        return Err(AppError::NotFound); // already bought/deleted concurrently
    }
    let category = if s.barcode.is_some() {
        ItemCategory::Food
    } else {
        ItemCategory::Other
    };
    let item = inventory_repo::create_item(
        &app.pool,
        &user.user_id,
        NewItem {
            name: s.name,
            category,
            quantity: s.quantity,
            unit: s.unit,
            expiry: None,
            location_id: None,
            barcode: s.barcode,
        },
    )
    .await?;
    Ok(Json(item))
}
