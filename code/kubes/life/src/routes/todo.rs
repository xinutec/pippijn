//! To-do list HTTP surface. Thin — delegates to `todo::repo`. The list is also
//! served offline via the RxDB sync endpoints (`/api/sync/todo`); these REST
//! routes are the online CRUD surface.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::error::AppError;
use crate::session::AuthUser;
use crate::state::AppState;
use crate::todo::types::{NewTodo, NewTodoLink, Todo, TodoLink, UpdateTodo};
use crate::todo::{links, repo};

pub async fn list(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<Todo>>, AppError> {
    Ok(Json(repo::list(&app.pool, &user.user_id).await?))
}

pub async fn create(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewTodo>,
) -> Result<Json<Todo>, AppError> {
    Ok(Json(repo::create(&app.pool, &user.user_id, body).await?))
}

pub async fn update(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
    Json(body): Json<UpdateTodo>,
) -> Result<Json<Todo>, AppError> {
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

// --- connections (todo_link) ---

pub async fn list_links(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<TodoLink>>, AppError> {
    Ok(Json(links::list(&app.pool, &user.user_id).await?))
}

pub async fn create_link(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewTodoLink>,
) -> Result<Json<TodoLink>, AppError> {
    Ok(Json(links::create(&app.pool, &user.user_id, body).await?))
}

pub async fn delete_link(
    State(app): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<u64>,
) -> Result<StatusCode, AppError> {
    if links::delete(&app.pool, &user.user_id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}
