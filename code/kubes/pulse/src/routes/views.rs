//! The read side: unauthenticated GET endpoints backing every UI view. The VPN
//! plus the ingress source-range whitelist is the access gate. Each handler is
//! thin and delegates to `report::repo`.

use axum::Json;
use axum::extract::{Path, Query, State};

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;

use crate::error::AppError;
use crate::report::repo;
use crate::report::types::{History, OverviewEntry, Problems, ReportDetail, ReportSummary};
use crate::state::AppState;

/// GET /api/overview — one tile per (source, collector) with its latest rollup.
pub async fn overview(State(app): State<AppState>) -> Result<Json<Vec<OverviewEntry>>, AppError> {
    Ok(Json(repo::overview(&app.pool).await?))
}

/// GET /api/problems — failing/warning checks + overdue/silent collectors.
pub async fn problems(State(app): State<AppState>) -> Result<Json<Problems>, AppError> {
    Ok(Json(repo::problems(&app.pool).await?))
}

#[derive(Debug, Deserialize)]
pub struct ReportsQuery {
    pub source: Option<String>,
    pub collector: Option<String>,
    pub limit: Option<u32>,
}

/// GET /api/reports — report history (runs), newest first, optional filters.
pub async fn reports(
    State(app): State<AppState>,
    Query(q): Query<ReportsQuery>,
) -> Result<Json<Vec<ReportSummary>>, AppError> {
    // Clamp the page size: a sane default, a hard ceiling to bound the response.
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    Ok(Json(
        repo::list_reports(
            &app.pool,
            q.source.as_deref(),
            q.collector.as_deref(),
            limit,
        )
        .await?,
    ))
}

/// GET /api/reports/:id — one report with all its checks.
pub async fn report(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ReportDetail>, AppError> {
    repo::report_detail(&app.pool, &id)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    pub source: String,
    pub collector: String,
    pub section: String,
    pub label: String,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

/// GET /api/history — time series for one check. Defaults to the last 30 days.
pub async fn history(
    State(app): State<AppState>,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<History>, AppError> {
    let to = q.to.unwrap_or_else(Utc::now);
    let from = q.from.unwrap_or_else(|| to - Duration::days(30));
    if from > to {
        return Err(AppError::BadRequest("from must be <= to".into()));
    }
    Ok(Json(
        repo::history(
            &app.pool,
            &q.source,
            &q.collector,
            &q.section,
            &q.label,
            from,
            to,
        )
        .await?,
    ))
}
