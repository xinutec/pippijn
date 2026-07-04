//! Per-user pacing settings (active window, night cutoff, nudge spacing).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, TS, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    pub timezone: String,
    pub window_start_hour: i32,
    pub window_end_hour: i32,
    pub night_cutoff_hour: i32,
    pub min_rest_min: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            timezone: "Europe/London".to_string(),
            window_start_hour: 8,
            window_end_hour: 21,
            night_cutoff_hour: 21,
            min_rest_min: 20,
        }
    }
}

/// Body for PATCH /api/settings. Only present fields are written.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingsPatch {
    pub timezone: Option<String>,
    pub window_start_hour: Option<i32>,
    pub window_end_hour: Option<i32>,
    pub night_cutoff_hour: Option<i32>,
    pub min_rest_min: Option<i32>,
}
