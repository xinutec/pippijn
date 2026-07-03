//! Staleness: how current a collector's latest report is, derived purely from
//! the report age and its self-declared `interval_s`. No server-side config and
//! no cron — it's computed at read time from the last report. A producer that
//! changes cadence updates `interval_s` with its next report.
//!
//! Pure and unit-tested (tests/staleness.rs) — no DB, no clock.

use super::types::Freshness;

/// A collector that declares no interval is assumed hourly — the fleet's
/// densest cadence, so an unknown cadence errs toward flagging silence sooner.
pub const DEFAULT_INTERVAL_S: i64 = 3600;

/// Classify a report `age_s` old against its declared `interval_s`:
/// - `Fresh`   — arrived within 1.5× the interval (one late tick tolerated)
/// - `Overdue` — 1.5× to 3× (rendered as a warning)
/// - `Silent`  — beyond 3× (rendered as a failure: the producer is likely dead)
pub fn freshness(age_s: i64, interval_s: Option<u64>) -> Freshness {
    let interval = interval_s.map(|i| i as i64).unwrap_or(DEFAULT_INTERVAL_S);
    // A zero/absent interval would collapse the bands; floor it at the default.
    let interval = interval.max(1);
    // Integer math, ×2 numerator to express the 1.5 boundary without floats.
    if age_s * 2 <= interval * 3 {
        Freshness::Fresh
    } else if age_s <= interval * 3 {
        Freshness::Overdue
    } else {
        Freshness::Silent
    }
}
