//! Persistence for reports + checks: ingest (idempotent) and the read queries
//! that back every UI view.
//!
//! All timestamps are handled as UTC. Columns are DATETIME(3); we bind
//! `naive_utc()` and read `NaiveDateTime` then `.and_utc()`, so nothing depends
//! on the DB session timezone. Ages are computed in Rust against `Utc::now()`.

use anyhow::Result;
use chrono::{DateTime, NaiveDateTime, Utc};
use sqlx::MySqlPool;
use ulid::Ulid;

use super::staleness::freshness;
use super::types::{
    CheckOut, CheckUpload, Freshness, History, HistoryPoint, IngestAck, OverviewEntry,
    ProblemCheck, Problems, ReportDetail, ReportSummary, ReportUpload, SCHEMA, Verdict,
};
use crate::error::AppError;

/// Validate + store one uploaded report under `source` (from the token). Returns
/// an ack marking whether this was a fresh store or an idempotent replay.
///
/// `raw` is the exact request body, kept for schema-evolution replay. Validation
/// failures surface as `AppError::Unprocessable` (422); the caller has already
/// authenticated.
pub async fn ingest(
    pool: &MySqlPool,
    source: &str,
    upload: &ReportUpload,
    raw: &str,
) -> Result<IngestAck, AppError> {
    if upload.schema != SCHEMA {
        return Err(AppError::Unprocessable(format!(
            "unsupported schema version {} (this vantage accepts {SCHEMA})",
            upload.schema
        )));
    }
    // The id is the idempotency key + primary key — it must be a real ULID.
    if Ulid::from_string(&upload.id).is_err() {
        return Err(AppError::Unprocessable(format!(
            "id {:?} is not a valid ULID",
            upload.id
        )));
    }
    if upload.collector.trim().is_empty() {
        return Err(AppError::Unprocessable(
            "collector must not be empty".into(),
        ));
    }

    let (mut n_pass, mut n_warn, mut n_fail, mut n_skip) = (0u32, 0u32, 0u32, 0u32);
    for c in &upload.checks {
        match c.verdict {
            Verdict::Pass => n_pass += 1,
            Verdict::Warn => n_warn += 1,
            Verdict::Fail => n_fail += 1,
            Verdict::Skip => n_skip += 1,
        }
    }
    let ok = n_fail == 0;
    let collected = upload.collected_at.naive_utc();
    let received = Utc::now().naive_utc();

    let mut tx = pool.begin().await.map_err(AppError::from)?;

    // INSERT IGNORE: a duplicate id (spool replay) leaves rows_affected == 0, so
    // we skip re-inserting the checks and report it as a no-op. The FK from
    // check_result means the checks only exist if the report row was created.
    let res = sqlx::query(
        "INSERT IGNORE INTO report \
         (id, source, collector, schema_ver, collected_at, received_at, duration_ms, \
          interval_s, ok, n_pass, n_warn, n_fail, n_skip, raw) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&upload.id)
    .bind(source)
    .bind(&upload.collector)
    .bind(upload.schema)
    .bind(collected)
    .bind(received)
    .bind(upload.duration_ms)
    .bind(upload.interval_s)
    .bind(ok)
    .bind(n_pass)
    .bind(n_warn)
    .bind(n_fail)
    .bind(n_skip)
    .bind(raw)
    .execute(&mut *tx)
    .await
    .map_err(AppError::from)?;

    if res.rows_affected() == 0 {
        tx.rollback().await.map_err(AppError::from)?;
        return Ok(IngestAck {
            id: upload.id.clone(),
            duplicate: true,
            checks: 0,
        });
    }

    for (seq, c) in upload.checks.iter().enumerate() {
        insert_check(
            &mut tx,
            &upload.id,
            source,
            &upload.collector,
            collected,
            seq as u32,
            c,
        )
        .await?;
    }
    tx.commit().await.map_err(AppError::from)?;

    Ok(IngestAck {
        id: upload.id.clone(),
        duplicate: false,
        checks: upload.checks.len() as u32,
    })
}

async fn insert_check(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    report_id: &str,
    source: &str,
    collector: &str,
    collected: NaiveDateTime,
    seq: u32,
    c: &CheckUpload,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO check_result \
         (report_id, seq, source, collector, collected_at, section, label, subject, \
          verdict, observed, expected, value, unit, doc_ref, detail) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(report_id)
    .bind(seq)
    .bind(source)
    .bind(collector)
    .bind(collected)
    .bind(&c.section)
    .bind(&c.label)
    .bind(&c.subject)
    .bind(c.verdict.to_string())
    .bind(&c.observed)
    .bind(&c.expected)
    .bind(c.value)
    .bind(&c.unit)
    .bind(&c.doc_ref)
    .bind(&c.detail)
    .execute(&mut **tx)
    .await
    .map_err(AppError::from)?;
    Ok(())
}

fn parse_verdict(s: &str) -> Result<Verdict> {
    s.parse::<Verdict>().map_err(anyhow::Error::msg)
}

fn worst_of(n_fail: u32, n_warn: u32, n_pass: u32) -> Verdict {
    if n_fail > 0 {
        Verdict::Fail
    } else if n_warn > 0 {
        Verdict::Warn
    } else if n_pass > 0 {
        Verdict::Pass
    } else {
        Verdict::Skip
    }
}

#[derive(sqlx::FromRow)]
struct LatestRow {
    id: String,
    source: String,
    collector: String,
    collected_at: NaiveDateTime,
    interval_s: Option<u64>,
    n_pass: u32,
    n_warn: u32,
    n_fail: u32,
    n_skip: u32,
}

/// Latest report per (source, collector) → one overview tile each, newest first
/// by source/collector name. Freshness is computed here against the wall clock.
pub async fn overview(pool: &MySqlPool) -> Result<Vec<OverviewEntry>> {
    let rows: Vec<LatestRow> = sqlx::query_as(
        "SELECT id, source, collector, collected_at, interval_s, n_pass, n_warn, n_fail, n_skip \
         FROM ( \
           SELECT r.*, ROW_NUMBER() OVER \
             (PARTITION BY source, collector ORDER BY collected_at DESC, id DESC) rn \
           FROM report r \
         ) x WHERE rn = 1 ORDER BY source, collector",
    )
    .fetch_all(pool)
    .await?;

    let now = Utc::now();
    Ok(rows.into_iter().map(|r| overview_entry(&now, r)).collect())
}

fn overview_entry(now: &DateTime<Utc>, r: LatestRow) -> OverviewEntry {
    let collected = r.collected_at.and_utc();
    let age_s = (*now - collected).num_seconds();
    OverviewEntry {
        source: r.source,
        collector: r.collector,
        report_id: r.id,
        collected_at: collected,
        age_s,
        interval_s: r.interval_s,
        freshness: freshness(age_s, r.interval_s),
        worst: worst_of(r.n_fail, r.n_warn, r.n_pass),
        pass: r.n_pass,
        warn: r.n_warn,
        fail: r.n_fail,
        skip: r.n_skip,
        total: r.n_pass + r.n_warn + r.n_fail + r.n_skip,
    }
}

#[derive(sqlx::FromRow)]
struct ProblemRow {
    source: String,
    collector: String,
    report_id: String,
    section: String,
    label: String,
    subject: Option<String>,
    verdict: String,
    observed: Option<String>,
    expected: Option<String>,
    doc_ref: Option<String>,
    collected_at: NaiveDateTime,
}

/// The problems view: every failing/warning check from each collector's latest
/// report, plus collectors whose latest report has gone overdue/silent (which no
/// check can express — a dead producer emits nothing).
pub async fn problems(pool: &MySqlPool) -> Result<Problems> {
    let rows: Vec<ProblemRow> = sqlx::query_as(
        "WITH latest AS ( \
           SELECT id FROM ( \
             SELECT id, ROW_NUMBER() OVER \
               (PARTITION BY source, collector ORDER BY collected_at DESC, id DESC) rn \
             FROM report \
           ) x WHERE rn = 1 \
         ) \
         SELECT c.source, c.collector, c.report_id, c.section, c.label, c.subject, \
                c.verdict, c.observed, c.expected, c.doc_ref, c.collected_at \
         FROM check_result c JOIN latest l ON c.report_id = l.id \
         WHERE c.verdict IN ('fail', 'warn') \
         ORDER BY FIELD(c.verdict, 'fail', 'warn'), c.source, c.collector, c.section, c.seq",
    )
    .fetch_all(pool)
    .await?;

    let checks = rows
        .into_iter()
        .map(|r| -> Result<ProblemCheck> {
            Ok(ProblemCheck {
                source: r.source,
                collector: r.collector,
                report_id: r.report_id,
                section: r.section,
                label: r.label,
                subject: r.subject,
                verdict: parse_verdict(&r.verdict)?,
                observed: r.observed,
                expected: r.expected,
                doc_ref: r.doc_ref,
                collected_at: r.collected_at.and_utc(),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let stale = overview(pool)
        .await?
        .into_iter()
        .filter(|e| e.freshness != Freshness::Fresh)
        .collect();

    Ok(Problems { checks, stale })
}

#[derive(sqlx::FromRow)]
struct SummaryRow {
    id: String,
    source: String,
    collector: String,
    collected_at: NaiveDateTime,
    duration_ms: Option<u64>,
    ok: bool,
    n_pass: u32,
    n_warn: u32,
    n_fail: u32,
    n_skip: u32,
}

/// Report history (the "runs" list), newest first, optionally filtered by
/// source and/or collector. `limit` is clamped by the caller.
pub async fn list_reports(
    pool: &MySqlPool,
    source: Option<&str>,
    collector: Option<&str>,
    limit: u32,
) -> Result<Vec<ReportSummary>> {
    let rows: Vec<SummaryRow> = sqlx::query_as(
        "SELECT id, source, collector, collected_at, duration_ms, ok, \
                n_pass, n_warn, n_fail, n_skip \
         FROM report \
         WHERE (? IS NULL OR source = ?) AND (? IS NULL OR collector = ?) \
         ORDER BY collected_at DESC, id DESC LIMIT ?",
    )
    .bind(source)
    .bind(source)
    .bind(collector)
    .bind(collector)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ReportSummary {
            id: r.id,
            source: r.source,
            collector: r.collector,
            collected_at: r.collected_at.and_utc(),
            duration_ms: r.duration_ms,
            ok: r.ok,
            pass: r.n_pass,
            warn: r.n_warn,
            fail: r.n_fail,
            skip: r.n_skip,
            total: r.n_pass + r.n_warn + r.n_fail + r.n_skip,
        })
        .collect())
}

#[derive(sqlx::FromRow)]
struct DetailRow {
    id: String,
    source: String,
    collector: String,
    schema_ver: u32,
    collected_at: NaiveDateTime,
    received_at: NaiveDateTime,
    duration_ms: Option<u64>,
    interval_s: Option<u64>,
    ok: bool,
}

#[derive(sqlx::FromRow)]
struct CheckRow {
    section: String,
    label: String,
    subject: Option<String>,
    verdict: String,
    observed: Option<String>,
    expected: Option<String>,
    value: Option<f64>,
    unit: Option<String>,
    doc_ref: Option<String>,
    detail: Option<String>,
}

/// One report with all its checks in report order, or None if the id is unknown.
pub async fn report_detail(pool: &MySqlPool, id: &str) -> Result<Option<ReportDetail>> {
    let Some(r): Option<DetailRow> = sqlx::query_as(
        "SELECT id, source, collector, schema_ver, collected_at, received_at, \
                duration_ms, interval_s, ok FROM report WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    let check_rows: Vec<CheckRow> = sqlx::query_as(
        "SELECT section, label, subject, verdict, observed, expected, value, unit, \
                doc_ref, detail FROM check_result WHERE report_id = ? ORDER BY seq",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;

    let checks = check_rows
        .into_iter()
        .map(|c| -> Result<CheckOut> {
            Ok(CheckOut {
                section: c.section,
                label: c.label,
                subject: c.subject,
                verdict: parse_verdict(&c.verdict)?,
                observed: c.observed,
                expected: c.expected,
                value: c.value,
                unit: c.unit,
                doc_ref: c.doc_ref,
                detail: c.detail,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Some(ReportDetail {
        id: r.id,
        source: r.source,
        collector: r.collector,
        schema: r.schema_ver,
        collected_at: r.collected_at.and_utc(),
        received_at: r.received_at.and_utc(),
        duration_ms: r.duration_ms,
        interval_s: r.interval_s,
        ok: r.ok,
        checks,
    }))
}

#[derive(sqlx::FromRow)]
struct HistoryRow {
    collected_at: NaiveDateTime,
    verdict: String,
    value: Option<f64>,
    unit: Option<String>,
}

/// Time series for one `(source, collector, section, label)` check between two
/// instants, oldest first. `unit` is taken from the most recent point that has
/// one (the current meaning of the numeric).
pub async fn history(
    pool: &MySqlPool,
    source: &str,
    collector: &str,
    section: &str,
    label: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<History> {
    let rows: Vec<HistoryRow> = sqlx::query_as(
        "SELECT collected_at, verdict, value, unit FROM check_result \
         WHERE source = ? AND collector = ? AND section = ? AND label = ? \
           AND collected_at BETWEEN ? AND ? \
         ORDER BY collected_at",
    )
    .bind(source)
    .bind(collector)
    .bind(section)
    .bind(label)
    .bind(from.naive_utc())
    .bind(to.naive_utc())
    .fetch_all(pool)
    .await?;

    let unit = rows.iter().rev().find_map(|r| r.unit.clone());
    let points = rows
        .into_iter()
        .map(|r| -> Result<HistoryPoint> {
            Ok(HistoryPoint {
                collected_at: r.collected_at.and_utc(),
                verdict: parse_verdict(&r.verdict)?,
                value: r.value,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(History {
        source: source.to_string(),
        collector: collector.to_string(),
        section: section.to_string(),
        label: label.to_string(),
        unit,
        points,
    })
}
