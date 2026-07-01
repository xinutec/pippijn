//! Application error type with an axum `IntoResponse` so handlers can `?`.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not authenticated")]
    Unauthorized,

    #[error("not found")]
    NotFound,

    /// Client sent something we can't accept (bad mime, empty/oversized upload).
    #[error("{0}")]
    BadRequest(String),

    // Constructed by the CalDAV layer once it reads nc_credentials; the
    // response mapping is wired up already.
    #[error("nextcloud not linked")]
    NcNotLinked,

    #[error("nextcloud app password no longer valid — relink required")]
    NcReauthRequired,

    /// Anything unexpected → 500, body is generic, detail is logged.
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Other(e.into())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Other(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            AppError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            AppError::NcNotLinked => (StatusCode::CONFLICT, self.to_string()),
            AppError::NcReauthRequired => (StatusCode::CONFLICT, self.to_string()),
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
