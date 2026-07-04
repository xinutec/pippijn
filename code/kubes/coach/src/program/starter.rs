//! The seeded starter program: a 4-week block (3 build weeks + 1 deload) across
//! the kit. Defined in code (not committed SQL) so no user id is baked into the
//! repo; the generator stamps the current user when the program is created.

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate, Utc};

use super::types::GenTarget;

pub const STARTER_NAME: &str = "Starter block";
pub const STARTER_WEEKS: i32 = 4;
pub const STARTER_DELOAD_WEEK: i32 = 4;

/// One line of the template: a weekly base for week 1, progressed across the
/// build weeks and cut on the deload week by [`generate`].
struct Entry {
    slug: &'static str,
    base_sets: i32,
    rep_low: Option<i32>,
    rep_high: Option<i32>,
    load_kg: Option<f64>,
    hold_s: Option<i32>,
}

/// A balanced full-body template: push / pull / legs / core off the rings, bar,
/// weights, and mat. Loads are conservative starting points to edit.
const TEMPLATE: &[Entry] = &[
    // pull
    Entry { slug: "pull_up",           base_sets: 4, rep_low: Some(5),  rep_high: Some(8),  load_kg: None,        hold_s: None },
    Entry { slug: "ring_row",          base_sets: 3, rep_low: Some(8),  rep_high: Some(12), load_kg: None,        hold_s: None },
    // push
    Entry { slug: "ring_dip",          base_sets: 4, rep_low: Some(5),  rep_high: Some(8),  load_kg: None,        hold_s: None },
    Entry { slug: "push_up",           base_sets: 3, rep_low: Some(12), rep_high: Some(18), load_kg: None,        hold_s: None },
    Entry { slug: "overhead_press",    base_sets: 3, rep_low: Some(6),  rep_high: Some(10), load_kg: Some(20.0),  hold_s: None },
    // legs
    Entry { slug: "goblet_squat",      base_sets: 4, rep_low: Some(8),  rep_high: Some(12), load_kg: Some(16.0),  hold_s: None },
    Entry { slug: "split_squat",       base_sets: 3, rep_low: Some(8),  rep_high: Some(12), load_kg: Some(12.0),  hold_s: None },
    // core
    Entry { slug: "hanging_leg_raise", base_sets: 3, rep_low: Some(8),  rep_high: Some(12), load_kg: None,        hold_s: None },
    Entry { slug: "l_sit",             base_sets: 3, rep_low: None,      rep_high: None,     load_kg: None,        hold_s: Some(15) },
    Entry { slug: "plank",             base_sets: 3, rep_low: None,      rep_high: None,     load_kg: None,        hold_s: Some(45) },
    Entry { slug: "dead_hang",         base_sets: 2, rep_low: None,      rep_high: None,     load_kg: None,        hold_s: Some(30) },
];

/// Monday of the current ISO week (the default program anchor).
pub fn current_week_monday() -> NaiveDate {
    let today = Utc::now().date_naive();
    today - chrono::Duration::days(today.weekday().num_days_from_monday() as i64)
}

/// Expand the template into explicit per-week targets. Build weeks progress
/// (reps creep up, a top set is added at week 3); the deload week halves volume
/// and drops to the bottom of the rep range. Load is held across the block —
/// load progression happens between mesocycles, not within one.
///
/// `catalog` maps exercise slug → id; template rows whose slug is missing (a
/// renamed/removed built-in) are skipped.
pub fn generate(
    catalog: &HashMap<String, i64>,
    weeks: i32,
    deload_week: Option<i32>,
) -> Vec<GenTarget> {
    let mut out = Vec::new();
    for e in TEMPLATE {
        let Some(&exercise_id) = catalog.get(e.slug) else {
            continue;
        };
        for week in 1..=weeks {
            let target = if Some(week) == deload_week {
                GenTarget {
                    exercise_id,
                    week_index: week,
                    target_sets: ((e.base_sets as f64) * 0.5).ceil() as i32,
                    rep_low: e.rep_low,
                    rep_high: e.rep_low, // hold at the bottom of the range
                    load_kg: e.load_kg,
                    hold_s: e.hold_s.map(|h| (h / 2).max(5)),
                }
            } else {
                // Build position 1,2,3,… among non-deload weeks (deload is last
                // in the starter, so week index == build position here).
                let pos = week;
                let bump = pos - 1;
                GenTarget {
                    exercise_id,
                    week_index: week,
                    target_sets: e.base_sets + if pos >= 3 { 1 } else { 0 },
                    rep_low: e.rep_low.map(|r| r + bump),
                    rep_high: e.rep_high.map(|r| r + bump),
                    load_kg: e.load_kg,
                    hold_s: e.hold_s.map(|h| h + bump * 5),
                }
            };
            out.push(target);
        }
    }
    out
}
