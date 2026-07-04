//! Exercise catalog wire types + the shared movement/equipment/metric enums.
//!
//! The enums serialize as snake_case to JSON (serde). For the DB they carry
//! `as_db`/`from_db` string conversions: rows are read into `ExerciseRow` (plain
//! `String` columns) and converted, and writes bind `as_db()`. This sidesteps
//! sqlx deriving `Type` for a MySQL `ENUM` column (which compares ENUM variant
//! sets and rejects the column).

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Add `as_db`/`from_db` string conversions to a fieldless enum. The literals
/// are the exact ENUM values stored in the DB.
macro_rules! db_str {
    ($name:ident { $($variant:ident => $s:literal),+ $(,)? }) => {
        impl $name {
            pub fn as_db(self) -> &'static str {
                match self { $(Self::$variant => $s),+ }
            }
            pub fn from_db(s: &str) -> Option<Self> {
                match s { $($s => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}

/// Where the exercise is done — also the kit inventory (rings, 2 m bar, weights,
/// mat, or plain bodyweight).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Equipment {
    Rings,
    Bar,
    Weights,
    Mat,
    Bodyweight,
}
db_str!(Equipment {
    Rings => "rings",
    Bar => "bar",
    Weights => "weights",
    Mat => "mat",
    Bodyweight => "bodyweight",
});

/// Movement pattern. Doubles as the recovery grouping: the pacing engine rests a
/// pattern that was recently worked hard.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Pattern {
    Push,
    Pull,
    Legs,
    Core,
}
db_str!(Pattern {
    Push => "push",
    Pull => "pull",
    Legs => "legs",
    Core => "core",
});

/// How a set is measured. Determines which of reps/load/hold a logged set carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Metric {
    Reps,
    WeightedReps,
    Hold,
}
db_str!(Metric {
    Reps => "reps",
    WeightedReps => "weighted_reps",
    Hold => "hold",
});

/// Public wire type. Built from an [`ExerciseRow`] read from the DB.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Exercise {
    #[ts(type = "number")]
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub equipment: Equipment,
    pub pattern: Pattern,
    pub metric: Metric,
    pub unilateral: bool,
    pub is_active: bool,
}

/// DB row shape (enum columns as raw strings). Converted to [`Exercise`].
#[derive(sqlx::FromRow)]
pub(crate) struct ExerciseRow {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub equipment: String,
    pub pattern: String,
    pub metric: String,
    pub unilateral: bool,
    pub is_active: bool,
}

impl TryFrom<ExerciseRow> for Exercise {
    type Error = anyhow::Error;
    fn try_from(r: ExerciseRow) -> Result<Self> {
        Ok(Exercise {
            id: r.id,
            slug: r.slug,
            name: r.name,
            equipment: Equipment::from_db(&r.equipment)
                .ok_or_else(|| anyhow!("unknown equipment {:?}", r.equipment))?,
            pattern: Pattern::from_db(&r.pattern)
                .ok_or_else(|| anyhow!("unknown pattern {:?}", r.pattern))?,
            metric: Metric::from_db(&r.metric)
                .ok_or_else(|| anyhow!("unknown metric {:?}", r.metric))?,
            unilateral: r.unilateral,
            is_active: r.is_active,
        })
    }
}

/// Body for POST /api/exercises (a user-added custom movement).
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewExercise {
    pub name: String,
    pub equipment: Equipment,
    pub pattern: Pattern,
    pub metric: Metric,
    #[serde(default)]
    pub unilateral: bool,
}

/// Body for PATCH /api/exercises/{id}. Every field optional; only present ones
/// are written.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExercisePatch {
    pub name: Option<String>,
    pub equipment: Option<Equipment>,
    pub pattern: Option<Pattern>,
    pub metric: Option<Metric>,
    pub unilateral: Option<bool>,
    pub is_active: Option<bool>,
}
