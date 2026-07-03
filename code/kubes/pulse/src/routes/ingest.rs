//! POST /api/reports — the one authenticated endpoint. A producer presents a
//! bearer token; the matching `source` is stamped server-side (never taken from
//! the body). The body is parsed *after* auth so an unauthenticated caller
//! learns nothing about the schema.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::{Json, body::Bytes};

use crate::auth;
use crate::error::AppError;
use crate::report::repo;
use crate::report::types::ReportUpload;
use crate::state::AppState;

/// Accept a report. 201 on a fresh store, 200 on an idempotent duplicate (spool
/// replay), 401 on a bad token, 422 on a schema/shape violation.
///
/// Takes the raw bytes (not `Json<ReportUpload>`) so we can both (a) keep the
/// exact payload for `raw` storage and schema replay, and (b) return our own
/// 422 with a reason instead of axum's default rejection.
pub async fn create(
    State(app): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, AppError> {
    let source = auth::authenticate(&headers, &app.cfg.tokens).ok_or(AppError::Unauthorized)?;

    let raw = std::str::from_utf8(&body)
        .map_err(|_| AppError::Unprocessable("body is not valid UTF-8".into()))?;
    let upload: ReportUpload = serde_json::from_str(raw)
        .map_err(|e| AppError::Unprocessable(format!("invalid report JSON: {e}")))?;

    let ack = repo::ingest(&app.pool, &source, &upload, raw).await?;
    let status = if ack.duplicate {
        StatusCode::OK
    } else {
        tracing::info!(
            source = %source,
            collector = %upload.collector,
            checks = ack.checks,
            "ingested report {}",
            ack.id
        );
        StatusCode::CREATED
    };
    Ok((status, Json(ack)))
}
