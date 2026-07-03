//! Application error type with an axum `IntoResponse` so handlers can `?`.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Missing/invalid ingest bearer token.
    #[error("not authenticated")]
    Unauthorized,

    #[error("not found")]
    NotFound,

    /// Malformed request the client should fix (bad query params).
    #[error("{0}")]
    BadRequest(String),

    /// Syntactically-fine JSON that fails our contract (unknown schema version,
    /// bad ULID, unknown verdict). Distinct from BadRequest so producers can
    /// tell "you sent junk" (422) from "you asked for something silly" (400).
    #[error("{0}")]
    Unprocessable(String),

    /// Anything unexpected → 500, body is generic, detail is logged.
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Other(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            AppError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            AppError::Unprocessable(_) => (StatusCode::UNPROCESSABLE_ENTITY, self.to_string()),
            AppError::Other(e) => {
                tracing::error!("internal error: {e:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
