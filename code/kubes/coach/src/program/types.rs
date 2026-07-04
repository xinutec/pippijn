//! Program (mesocycle) wire types: the program, its explicit per-week targets,
//! and optional day pins.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, TS, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Program {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub start_date: NaiveDate,
    pub weeks: i32,
    pub deload_week: Option<i32>,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, TS, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProgramTarget {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub exercise_id: i64,
    pub week_index: i32,
    pub target_sets: i32,
    pub rep_low: Option<i32>,
    pub rep_high: Option<i32>,
    pub load_kg: Option<f64>,
    pub hold_s: Option<i32>,
}

#[derive(Clone, Debug, Serialize, TS, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProgramPin {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub exercise_id: i64,
    pub weekday: i32,
    pub sets: i32,
}

/// A program plus its full week-by-week targets and any day pins.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProgramDetail {
    pub program: Program,
    pub targets: Vec<ProgramTarget>,
    pub pins: Vec<ProgramPin>,
}

/// Body for POST /api/programs/starter. When `startDate` is omitted the program
/// anchors on the current week's Monday.
#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StarterRequest {
    pub start_date: Option<NaiveDate>,
}

/// Body for PATCH /api/program-targets/{id}. Only present fields are written.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TargetPatch {
    pub target_sets: Option<i32>,
    pub rep_low: Option<i32>,
    pub rep_high: Option<i32>,
    pub load_kg: Option<f64>,
    pub hold_s: Option<i32>,
}

/// Body for POST /api/programs/{id}/pins (upsert per exercise+weekday).
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewPin {
    #[ts(type = "number")]
    pub exercise_id: i64,
    pub weekday: i32,
    pub sets: i32,
}

/// A generated target row, produced by the starter template before it's written.
/// Internal (not a wire type).
#[derive(Clone, Debug)]
pub struct GenTarget {
    pub exercise_id: i64,
    pub week_index: i32,
    pub target_sets: i32,
    pub rep_low: Option<i32>,
    pub rep_high: Option<i32>,
    pub load_kg: Option<f64>,
    pub hold_s: Option<i32>,
}
