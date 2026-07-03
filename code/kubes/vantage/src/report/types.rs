//! Report + check types: the wire format producers POST, and the shapes the UI
//! reads back. Response types derive `TS` so `scripts/gen-types.sh` keeps the
//! Angular interfaces in lock-step (see frontend/src/app/generated/).
//!
//! Deliberate shape decisions (see docs/design.md §4.1):
//! - `source` is NOT in the upload — it's derived from the ingest token, so a
//!   producer can only write as itself.
//! - a check's trend identity is `(source, collector, section, label)`; `label`
//!   must be stable across runs, with run-varying data in `observed`/`value`.
//! - one optional numeric per check (`value`/`unit`) drives the trend charts.

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The wire schema version vantage currently accepts. Bumped only on a
/// breaking change to the report shape; the server rejects anything else (422).
pub const SCHEMA: u32 = 1;

/// A check's outcome. Mirrors the `Verdict` enum the CLI tools already use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Verdict {
    Pass,
    Warn,
    Fail,
    Skip,
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Verdict::Pass => "pass",
            Verdict::Warn => "warn",
            Verdict::Fail => "fail",
            Verdict::Skip => "skip",
        })
    }
}

impl FromStr for Verdict {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pass" => Ok(Verdict::Pass),
            "warn" => Ok(Verdict::Warn),
            "fail" => Ok(Verdict::Fail),
            "skip" => Ok(Verdict::Skip),
            other => Err(format!("unknown verdict {other:?}")),
        }
    }
}

/// How current a collector's latest report is, computed at read time from the
/// report's declared `interval_s` (see `report::staleness`). A push-based
/// monitor's worst failure is a dead producer looking green, so this is
/// first-class: `Silent` renders as a failure, `Overdue` as a warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Freshness {
    Fresh,
    Overdue,
    Silent,
}

// --- upload (producer → vantage). Deserialize only; producers aren't TS. ---

/// One report POSTed by a producer. `id` is a producer-minted ULID used as the
/// idempotency key (the spool may re-send after a network flap).
#[derive(Debug, Clone, Deserialize)]
pub struct ReportUpload {
    pub schema: u32,
    pub id: String,
    pub collector: String,
    pub collected_at: DateTime<Utc>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub interval_s: Option<u64>,
    pub checks: Vec<CheckUpload>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CheckUpload {
    pub section: String,
    pub label: String,
    #[serde(default)]
    pub subject: Option<String>,
    pub verdict: Verdict,
    #[serde(default)]
    pub observed: Option<String>,
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default, rename = "ref")]
    pub doc_ref: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

// --- responses (vantage → UI). Serialize + TS. ---

/// One tile on the overview: a (source, collector) with its latest rollup.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct OverviewEntry {
    pub source: String,
    pub collector: String,
    pub report_id: String,
    #[ts(type = "string")]
    pub collected_at: DateTime<Utc>,
    #[ts(type = "number")]
    pub age_s: i64,
    #[ts(type = "number | null")]
    pub interval_s: Option<u64>,
    pub freshness: Freshness,
    /// Worst verdict among the report's checks (drives the tile colour).
    pub worst: Verdict,
    pub pass: u32,
    pub warn: u32,
    pub fail: u32,
    pub skip: u32,
    pub total: u32,
}

/// A single failing/warning check surfaced on the problems view.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ProblemCheck {
    pub source: String,
    pub collector: String,
    pub report_id: String,
    pub section: String,
    pub label: String,
    pub subject: Option<String>,
    pub verdict: Verdict,
    pub observed: Option<String>,
    pub expected: Option<String>,
    #[serde(rename = "ref")]
    pub doc_ref: Option<String>,
    #[ts(type = "string")]
    pub collected_at: DateTime<Utc>,
}

/// The problems view: what's wrong right now — failing/warning checks plus
/// collectors that have gone silent/overdue (which no check can express).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Problems {
    pub checks: Vec<ProblemCheck>,
    pub stale: Vec<OverviewEntry>,
}

/// A check as rendered in a report's detail view.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct CheckOut {
    pub section: String,
    pub label: String,
    pub subject: Option<String>,
    pub verdict: Verdict,
    pub observed: Option<String>,
    pub expected: Option<String>,
    #[ts(type = "number | null")]
    pub value: Option<f64>,
    pub unit: Option<String>,
    #[serde(rename = "ref")]
    pub doc_ref: Option<String>,
    pub detail: Option<String>,
}

/// A full report with all its checks, grouped by the UI into sections.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ReportDetail {
    pub id: String,
    pub source: String,
    pub collector: String,
    pub schema: u32,
    #[ts(type = "string")]
    pub collected_at: DateTime<Utc>,
    #[ts(type = "string")]
    pub received_at: DateTime<Utc>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<u64>,
    #[ts(type = "number | null")]
    pub interval_s: Option<u64>,
    pub ok: bool,
    pub checks: Vec<CheckOut>,
}

/// A row in the "runs" list (report history for one collector).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ReportSummary {
    pub id: String,
    pub source: String,
    pub collector: String,
    #[ts(type = "string")]
    pub collected_at: DateTime<Utc>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<u64>,
    pub ok: bool,
    pub pass: u32,
    pub warn: u32,
    pub fail: u32,
    pub skip: u32,
    pub total: u32,
}

/// One point in a single check's time series.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct HistoryPoint {
    #[ts(type = "string")]
    pub collected_at: DateTime<Utc>,
    pub verdict: Verdict,
    #[ts(type = "number | null")]
    pub value: Option<f64>,
}

/// The time series for one `(source, collector, section, label)` check.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct History {
    pub source: String,
    pub collector: String,
    pub section: String,
    pub label: String,
    pub unit: Option<String>,
    pub points: Vec<HistoryPoint>,
}

/// Response to a successful ingest.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct IngestAck {
    pub id: String,
    /// true if this id was already stored (idempotent replay), false if new.
    pub duplicate: bool,
    pub checks: u32,
}
