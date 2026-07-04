//! Assemble the pacing engine's input from the DB and run it. All timezone
//! handling lives here: `logged_at` is stored UTC, the window/day math is done
//! in the user's local tz.

use anyhow::Result;
use chrono::{Duration, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use sqlx::MySqlPool;

use crate::exercise::repo as ex_repo;
use crate::program::repo as prog_repo;
use crate::settings::repo as settings_repo;
use crate::workout::repo as workout_repo;

use super::engine;
use super::types::{
    ExerciseInfo, PacingInput, PacingNow, PacingSettings, PinInfo, ProgramInfo, SetInfo, TargetInfo,
};

/// The pacing verdict for the user right now.
pub async fn now(pool: &MySqlPool, user_id: &str) -> Result<PacingNow> {
    let s = settings_repo::get(pool, user_id).await?;
    let tz: Tz = s.timezone.parse().unwrap_or(chrono_tz::Europe::London);
    let now_local = Utc::now().with_timezone(&tz).naive_local();
    let to_local = |utc: NaiveDateTime| Utc.from_utc_datetime(&utc).with_timezone(&tz).naive_local();

    let settings = PacingSettings {
        window_start_hour: s.window_start_hour,
        window_end_hour: s.window_end_hour,
        night_cutoff_hour: s.night_cutoff_hour,
        min_rest_min: s.min_rest_min,
    };

    let Some(active) = prog_repo::active(pool, user_id).await? else {
        let inp = PacingInput {
            program: None,
            exercises: Vec::new(),
            targets: Vec::new(),
            pins: Vec::new(),
            sets_this_week: Vec::new(),
            last_set_at: None,
            settings,
        };
        return Ok(engine::evaluate(&inp, now_local));
    };

    let exercises = ex_repo::list(pool, true)
        .await?
        .into_iter()
        .map(|e| ExerciseInfo {
            id: e.id,
            name: e.name,
            pattern: e.pattern,
        })
        .collect();

    let targets = prog_repo::targets(pool, active.id)
        .await?
        .into_iter()
        .map(|t| TargetInfo {
            exercise_id: t.exercise_id,
            week_index: t.week_index,
            target_sets: t.target_sets,
            rep_low: t.rep_low,
            rep_high: t.rep_high,
            load_kg: t.load_kg,
            hold_s: t.hold_s,
        })
        .collect();

    let pins = prog_repo::pins(pool, active.id)
        .await?
        .into_iter()
        .map(|p| PinInfo {
            exercise_id: p.exercise_id,
            weekday: p.weekday,
            sets: p.sets,
        })
        .collect();

    // Start of the current program week, in local time, converted to UTC for the
    // query (logged_at is stored UTC).
    let days_since = (now_local.date() - active.start_date).num_days().max(0);
    let week_start_date = active.start_date + Duration::days((days_since / 7) * 7);
    let week_start_local = week_start_date.and_hms_opt(0, 0, 0).unwrap();
    let week_start_utc = tz
        .from_local_datetime(&week_start_local)
        .single()
        .map(|d| d.with_timezone(&Utc).naive_utc())
        .unwrap_or(week_start_local);

    let raw_sets = workout_repo::list_since(pool, user_id, week_start_utc).await?;
    let sets_this_week: Vec<SetInfo> = raw_sets
        .iter()
        .map(|w| SetInfo {
            exercise_id: w.exercise_id,
            logged_at: to_local(w.logged_at),
        })
        .collect();
    let last_set_at = raw_sets.iter().map(|w| w.logged_at).max().map(to_local);

    let inp = PacingInput {
        program: Some(ProgramInfo {
            start_date: active.start_date,
            weeks: active.weeks,
            deload_week: active.deload_week,
        }),
        exercises,
        targets,
        pins,
        sets_this_week,
        last_set_at,
        settings,
    };
    Ok(engine::evaluate(&inp, now_local))
}
