//! The micro-log: one `WorkoutSet` row per set done "here and there".

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, TS, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkoutSet {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub exercise_id: i64,
    #[ts(type = "number | null")]
    pub program_id: Option<i64>,
    pub logged_at: NaiveDateTime,
    pub reps: Option<i32>,
    pub load_kg: Option<f64>,
    pub hold_s: Option<i32>,
    pub rpe: Option<i32>,
    pub note: Option<String>,
}

/// Body for POST /api/sets. `loggedAt` defaults to now; `programId` is filled
/// server-side from the active program.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewSet {
    #[ts(type = "number")]
    pub exercise_id: i64,
    pub reps: Option<i32>,
    pub load_kg: Option<f64>,
    pub hold_s: Option<i32>,
    pub rpe: Option<i32>,
    pub note: Option<String>,
    pub logged_at: Option<NaiveDateTime>,
}
