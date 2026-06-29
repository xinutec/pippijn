//! Product lookup: cache-first, Open Food Facts on a miss; plus image serving.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header;
use axum::response::Response;
use axum::Json;

use crate::error::AppError;
use crate::products::{off, repo, types::Product};
use crate::session::AuthUser;
use crate::state::AppState;

/// GET /api/products/{barcode} → cached metadata, fetching+caching from OFF on
/// a miss. 404 if OFF has no such product.
pub async fn lookup(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
    Path(barcode): Path<String>,
) -> Result<Json<Product>, AppError> {
    if let Some(p) = repo::get(&app.pool, &barcode).await? {
        return Ok(Json(p));
    }
    let found = off::fetch(&app.http, &barcode).await?.ok_or(AppError::NotFound)?;
    let image = match &found.image_url {
        Some(url) => off::fetch_image(&app.http, url).await.ok().flatten(),
        None => None,
    };
    repo::upsert(
        &app.pool,
        &barcode,
        found.name.as_deref(),
        found.brand.as_deref(),
        found.quantity.as_deref(),
        image,
    )
    .await?;
    repo::get(&app.pool, &barcode).await?.map(Json).ok_or(AppError::NotFound)
}

/// GET /api/products/{barcode}/image → the cached image bytes.
pub async fn image(
    State(app): State<AppState>,
    AuthUser(_user): AuthUser,
    Path(barcode): Path<String>,
) -> Result<Response, AppError> {
    let (bytes, mime) = repo::get_image(&app.pool, &barcode).await?.ok_or(AppError::NotFound)?;
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .body(Body::from(bytes))
        .map_err(|e| AppError::Other(e.into()))
}
