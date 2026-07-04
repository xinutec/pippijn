//! Pacing-engine tests. Integration tests (public API) rather than an inline
//! `#[cfg(test)] mod` in src/ — `evaluate` + its input/output types are public,
//! so the engine is exercised through the same surface callers use.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

use coach::exercise::types::Pattern;
use coach::pacing::engine::evaluate;
use coach::pacing::types::{
    ExerciseInfo, PacingInput, PacingSettings, PacingState, PinInfo, ProgramInfo, SetInfo,
    TargetInfo,
};

fn dt(y: i32, m: u32, d: u32, h: u32, min: u32) -> NaiveDateTime {
    NaiveDate::from_ymd_opt(y, m, d)
        .unwrap()
        .and_time(NaiveTime::from_hms_opt(h, min, 0).unwrap())
}

fn settings() -> PacingSettings {
    PacingSettings {
        window_start_hour: 8,
        window_end_hour: 21,
        night_cutoff_hour: 21,
        min_rest_min: 20,
    }
}

// Program starts Mon 2026-06-29, 4 weeks, deload wk4.
fn program() -> ProgramInfo {
    ProgramInfo {
        start_date: NaiveDate::from_ymd_opt(2026, 6, 29).unwrap(),
        weeks: 4,
        deload_week: Some(4),
    }
}

fn one_exercise() -> Vec<ExerciseInfo> {
    vec![ExerciseInfo {
        id: 1,
        name: "Pull-up".to_string(),
        pattern: Pattern::Pull,
    }]
}

// 7 sets/week of exercise 1, for the given week.
fn target(week: i32, sets: i32) -> TargetInfo {
    TargetInfo {
        exercise_id: 1,
        week_index: week,
        target_sets: sets,
        rep_low: Some(5),
        rep_high: Some(8),
        load_kg: None,
        hold_s: None,
    }
}

fn input(
    program: Option<ProgramInfo>,
    targets: Vec<TargetInfo>,
    pins: Vec<PinInfo>,
    sets: Vec<SetInfo>,
    last: Option<NaiveDateTime>,
) -> PacingInput {
    PacingInput {
        program,
        exercises: one_exercise(),
        targets,
        pins,
        sets_this_week: sets,
        last_set_at: last,
        settings: settings(),
    }
}

#[test]
fn no_program() {
    let inp = input(None, vec![], vec![], vec![], None);
    let out = evaluate(&inp, dt(2026, 6, 29, 10, 0));
    assert_eq!(out.state, PacingState::NoProgram);
    assert!(!out.nudge);
    assert!(out.suggestion.is_none());
}

#[test]
fn not_started() {
    let inp = input(Some(program()), vec![target(1, 7)], vec![], vec![], None);
    // Day before the program starts.
    let out = evaluate(&inp, dt(2026, 6, 28, 10, 0));
    assert_eq!(out.state, PacingState::NotStarted);
    assert!(!out.nudge);
}

#[test]
fn complete_after_last_week() {
    let inp = input(Some(program()), vec![target(1, 7)], vec![], vec![], None);
    // 4 weeks from Mon 06-29 → week 5 starts 07-27.
    let out = evaluate(&inp, dt(2026, 7, 27, 10, 0));
    assert_eq!(out.state, PacingState::Complete);
    assert_eq!(out.week_index, Some(5));
    assert!(!out.nudge);
}

#[test]
fn week_index_and_deload_detected() {
    let inp = input(Some(program()), vec![target(4, 3)], vec![], vec![], None);
    // Week 4 (deload): Mon 07-20.
    let out = evaluate(&inp, dt(2026, 7, 20, 10, 0));
    assert_eq!(out.week_index, Some(4));
    assert!(out.is_deload);
}

#[test]
fn behind_early_in_window_nudges() {
    // Monday 10:00, nothing done. 7/week over 7 days → 1 due today; the
    // window is ~15% elapsed with 0 done, so we're behind → nudge.
    let inp = input(Some(program()), vec![target(1, 7)], vec![], vec![], None);
    let out = evaluate(&inp, dt(2026, 6, 29, 10, 0));
    assert_eq!(out.state, PacingState::Active);
    assert_eq!(out.day_remaining_sets, 1);
    assert_eq!(out.week_remaining_sets, 7);
    assert!(out.within_window && !out.after_cutoff && out.spacing_ok);
    assert!(out.nudge);
    let sug = out.suggestion.unwrap();
    assert_eq!(sug.exercise_id, 1);
    assert_eq!(sug.sets, 1);
}

#[test]
fn right_at_window_open_not_behind() {
    // 08:00 exactly: window progress 0, ideal done 0 → not behind → no nudge,
    // even though there's work. Gives the morning a grace period.
    let inp = input(Some(program()), vec![target(1, 7)], vec![], vec![], None);
    let out = evaluate(&inp, dt(2026, 6, 29, 8, 0));
    assert!(out.day_remaining_sets > 0);
    assert!(!out.nudge);
}

#[test]
fn spacing_blocks_nudge() {
    // Behind, but a set was logged 5 min ago (< 20 min rest) → no nudge.
    let last = dt(2026, 6, 29, 9, 55);
    let inp = input(
        Some(program()),
        vec![target(1, 7)],
        vec![],
        vec![],
        Some(last),
    );
    let out = evaluate(&inp, dt(2026, 6, 29, 10, 0));
    assert!(!out.spacing_ok);
    assert!(!out.nudge);
}

#[test]
fn after_cutoff_no_nudge_rolls_over() {
    // 21:30, behind, but past the night cutoff → no nudge, roll-over reason.
    let inp = input(Some(program()), vec![target(1, 7)], vec![], vec![], None);
    let out = evaluate(&inp, dt(2026, 6, 29, 21, 30));
    assert!(out.after_cutoff);
    assert!(!out.nudge);
    assert!(out.reason.contains("roll to tomorrow"));
}

#[test]
fn done_for_today_when_target_met() {
    // Did today's 1 set → nothing remaining today → no nudge, done reason.
    let sets = vec![SetInfo {
        exercise_id: 1,
        logged_at: dt(2026, 6, 29, 9, 0),
    }];
    let inp = input(
        Some(program()),
        vec![target(1, 7)],
        vec![],
        sets,
        Some(dt(2026, 6, 29, 9, 0)),
    );
    let out = evaluate(&inp, dt(2026, 6, 29, 12, 0));
    assert_eq!(out.day_remaining_sets, 0);
    assert!(!out.nudge);
    assert!(out.reason.contains("done for today"));
    // One of 7 weekly sets done.
    assert_eq!(out.week_remaining_sets, 6);
}

#[test]
fn pin_raises_today_target() {
    // Pin 3 sets of exercise 1 to Monday (weekday 0). Today is Monday →
    // today's target is at least 3 (vs the fair share of 1).
    let pins = vec![PinInfo {
        exercise_id: 1,
        weekday: 0,
        sets: 3,
    }];
    let inp = input(Some(program()), vec![target(1, 7)], pins, vec![], None);
    let out = evaluate(&inp, dt(2026, 6, 29, 10, 0));
    assert_eq!(out.day_remaining_sets, 3);
}

#[test]
fn fair_share_rounds_up_midweek() {
    // Thursday (weekday 3) of week 1, 7 sets none done → 4 days left,
    // ceil(7/4)=2 due today.
    let inp = input(Some(program()), vec![target(1, 7)], vec![], vec![], None);
    let out = evaluate(&inp, dt(2026, 7, 2, 10, 0)); // Thu
    assert_eq!(out.day_remaining_sets, 2);
}

#[test]
fn not_behind_when_on_pace_no_nudge() {
    // Late in the window (20:00) having done today's 1 set earlier → on pace,
    // nothing left → no nudge.
    let sets = vec![SetInfo {
        exercise_id: 1,
        logged_at: dt(2026, 6, 29, 9, 0),
    }];
    let inp = input(
        Some(program()),
        vec![target(1, 7)],
        vec![],
        sets,
        Some(dt(2026, 6, 29, 9, 0)),
    );
    let out = evaluate(&inp, dt(2026, 6, 29, 20, 0));
    assert!(!out.nudge);
    assert_eq!(out.day_remaining_sets, 0);
}
