//! Recipe HTTP surface: CRUD plus the inventory-derived shopping-list and
//! cook-now views.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::error::AppError;
use crate::inventory::repo as inventory_repo;
use crate::recipes::matching;
use crate::recipes::repo;
use crate::recipes::types::{NewRecipe, Recipe, RecipeIngredient};
use crate::session::AuthUser;
use crate::state::AppState;

pub async fn list(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<Recipe>>, AppError> {
    Ok(Json(repo::list_recipes(&app.pool, &user.user_id).await?))
}

pub async fn create(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewRecipe>,
) -> Result<Json<Recipe>, AppError> {
    Ok(Json(
        repo::create_recipe(&app.pool, &user.user_id, body).await?,
    ))
}

pub async fn delete(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
) -> Result<StatusCode, AppError> {
    if repo::delete_recipe(&app.pool, &user.user_id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn get_one(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
) -> Result<Json<Recipe>, AppError> {
    repo::get_recipe(&app.pool, &user.user_id, id)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

/// The ingredients of a recipe not covered by current inventory.
pub async fn shopping_list(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
) -> Result<Json<Vec<RecipeIngredient>>, AppError> {
    let recipe = repo::get_recipe(&app.pool, &user.user_id, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let inventory = inventory_repo::list_items(&app.pool, &user.user_id).await?;
    Ok(Json(matching::shopping_list(
        &recipe.ingredients,
        &inventory,
    )))
}

/// Recipes whose ingredients are all currently in stock.
pub async fn cookable(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<Recipe>>, AppError> {
    let recipes = repo::list_recipes(&app.pool, &user.user_id).await?;
    let inventory = inventory_repo::list_items(&app.pool, &user.user_id).await?;
    let cookable = recipes
        .into_iter()
        .filter(|r| matching::can_cook(&r.ingredients, &inventory))
        .collect();
    Ok(Json(cookable))
}
