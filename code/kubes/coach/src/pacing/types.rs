//! Pacing engine input (plain data, assembled from repos) and output (wire
//! types). The engine [`super::engine::evaluate`] is a pure function over these.

use chrono::{NaiveDate, NaiveDateTime};
use serde::Serialize;
use ts_rs::TS;

use crate::exercise::types::Pattern;

// ---- inputs (internal; not wire types) -------------------------------------

pub struct ProgramInfo {
    pub start_date: NaiveDate,
    pub weeks: i32,
    pub deload_week: Option<i32>,
}

pub struct ExerciseInfo {
    pub id: i64,
    pub name: String,
    pub pattern: Pattern,
}

pub struct TargetInfo {
    pub exercise_id: i64,
    pub week_index: i32,
    pub target_sets: i32,
    pub rep_low: Option<i32>,
    pub rep_high: Option<i32>,
    pub load_kg: Option<f64>,
    pub hold_s: Option<i32>,
}

pub struct PinInfo {
    pub exercise_id: i64,
    pub weekday: i32,
    pub sets: i32,
}

pub struct SetInfo {
    pub exercise_id: i64,
    pub logged_at: NaiveDateTime,
}

pub struct PacingSettings {
    pub window_start_hour: i32,
    pub window_end_hour: i32,
    pub night_cutoff_hour: i32,
    pub min_rest_min: i32,
}

/// Everything the engine needs, already fetched. `sets_this_week` are the live
/// sets logged in the current program week; `last_set_at` is the most recent set
/// overall (for the spacing gate).
pub struct PacingInput {
    pub program: Option<ProgramInfo>,
    pub exercises: Vec<ExerciseInfo>,
    pub targets: Vec<TargetInfo>,
    pub pins: Vec<PinInfo>,
    pub sets_this_week: Vec<SetInfo>,
    pub last_set_at: Option<NaiveDateTime>,
    pub settings: PacingSettings,
}

// ---- output (wire types) ---------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PacingState {
    /// No active program.
    NoProgram,
    /// The active program's start date is in the future.
    NotStarted,
    /// Past the last week of the mesocycle.
    Complete,
    /// A live program week.
    Active,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PatternProgress {
    pub pattern: Pattern,
    pub week_target: i32,
    pub week_done: i32,
    pub today_target: i32,
    pub today_done: i32,
    pub today_remaining: i32,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Suggestion {
    #[ts(type = "number")]
    pub exercise_id: i64,
    pub exercise_name: String,
    pub pattern: Pattern,
    pub sets: i32,
    pub rep_low: Option<i32>,
    pub rep_high: Option<i32>,
    pub load_kg: Option<f64>,
    pub hold_s: Option<i32>,
}

/// The full pacing verdict for an instant. Drives both the Today UI and the
/// Android nudge (which fires only when `nudge` is true AND the phone's geofence
/// says you're home).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PacingNow {
    pub state: PacingState,
    pub week_index: Option<i32>,
    pub is_deload: bool,
    /// True → a good moment to remind (subject to the caller's home gate).
    pub nudge: bool,
    pub reason: String,
    pub within_window: bool,
    pub after_cutoff: bool,
    pub spacing_ok: bool,
    #[ts(type = "number | null")]
    pub minutes_since_last_set: Option<i64>,
    pub day_remaining_sets: i32,
    pub week_remaining_sets: i32,
    pub patterns: Vec<PatternProgress>,
    pub suggestion: Option<Suggestion>,
}
