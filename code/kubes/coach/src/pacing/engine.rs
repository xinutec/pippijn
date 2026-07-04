//! The pacing engine: a pure function from (fetched state, instant) to a pacing
//! verdict. No I/O, no clock — the caller passes `now` (already in the user's
//! local tz). This is where the "spread it across the day, don't cram at 10pm"
//! behaviour lives; the tests below pin every branch.

use std::collections::HashMap;

use chrono::{Datelike, NaiveDateTime, Timelike};

use crate::exercise::types::Pattern;

use super::types::{
    PacingInput, PacingNow, PacingState, PatternProgress, Suggestion, TargetInfo,
};

fn ceil_div(a: i32, b: i32) -> i32 {
    debug_assert!(b > 0);
    (a + b - 1) / b
}

fn pattern_rank(p: Pattern) -> i32 {
    match p {
        Pattern::Push => 0,
        Pattern::Pull => 1,
        Pattern::Legs => 2,
        Pattern::Core => 3,
    }
}

/// Per-exercise working row (internal to a single evaluation).
struct Row<'a> {
    t: &'a TargetInfo,
    pattern: Pattern,
    exercise_id: i64,
    exercise_name: &'a str,
    remaining_week: i32,
    today_target: i32,
    today_done: i32,
    today_remaining: i32,
}

/// Evaluate the pacing state for `now` (local time).
pub fn evaluate(input: &PacingInput, now: NaiveDateTime) -> PacingNow {
    let s = &input.settings;
    let hour = now.hour() as i32;
    let within_window = hour >= s.window_start_hour && hour < s.window_end_hour;
    let after_cutoff = hour >= s.night_cutoff_hour;
    let minutes_since_last_set = input.last_set_at.map(|t| (now - t).num_minutes());
    let spacing_ok = minutes_since_last_set.is_none_or(|m| m >= s.min_rest_min as i64);

    let base = |state, week_index, is_deload, reason: String| PacingNow {
        state,
        week_index,
        is_deload,
        nudge: false,
        reason,
        within_window,
        after_cutoff,
        spacing_ok,
        minutes_since_last_set,
        day_remaining_sets: 0,
        week_remaining_sets: 0,
        patterns: Vec::new(),
        suggestion: None,
    };

    let Some(prog) = &input.program else {
        return base(
            PacingState::NoProgram,
            None,
            false,
            "No active program — start one to get going.".to_string(),
        );
    };

    let days_since = (now.date() - prog.start_date).num_days();
    if days_since < 0 {
        return base(
            PacingState::NotStarted,
            None,
            false,
            format!("Your program starts {}.", prog.start_date),
        );
    }
    let week_index = (days_since / 7) as i32 + 1;
    if week_index > prog.weeks {
        return base(
            PacingState::Complete,
            Some(week_index),
            false,
            "Program complete — time for a new block.".to_string(),
        );
    }
    let is_deload = prog.deload_week == Some(week_index);
    let weekday_index = (days_since % 7) as i32; // 0 = program week's first day
    let days_left = 7 - weekday_index; // includes today; 1..=7

    let ex_by_id: HashMap<i64, &super::types::ExerciseInfo> =
        input.exercises.iter().map(|e| (e.id, e)).collect();

    let today = now.date();
    let mut done_week: HashMap<i64, i32> = HashMap::new();
    let mut done_today: HashMap<i64, i32> = HashMap::new();
    for set in &input.sets_this_week {
        *done_week.entry(set.exercise_id).or_default() += 1;
        if set.logged_at.date() == today {
            *done_today.entry(set.exercise_id).or_default() += 1;
        }
    }

    let mut rows: Vec<Row> = Vec::new();
    for t in input.targets.iter().filter(|t| t.week_index == week_index) {
        let Some(ex) = ex_by_id.get(&t.exercise_id) else {
            continue;
        };
        let dw = *done_week.get(&t.exercise_id).unwrap_or(&0);
        let dt = *done_today.get(&t.exercise_id).unwrap_or(&0);
        let remaining_week = (t.target_sets - dw).max(0);

        let pin_today: i32 = input
            .pins
            .iter()
            .filter(|p| p.exercise_id == t.exercise_id && p.weekday == weekday_index)
            .map(|p| p.sets)
            .sum();
        let future_pin: i32 = input
            .pins
            .iter()
            .filter(|p| p.exercise_id == t.exercise_id && p.weekday > weekday_index)
            .map(|p| p.sets)
            .sum();

        // Today's quota is computed from what remained at the START of today, so
        // it's stable through the day (logging a set doesn't ratchet the quota
        // up) while still catching up for volume missed on earlier days.
        let remaining_start = (t.target_sets - (dw - dt)).max(0);
        let floating_pool = (remaining_start - future_pin).max(0);
        let floating_today = ceil_div(floating_pool, days_left);
        // The bigger of the fair share and today's pin, capped at what's left.
        let quota = remaining_start.min(floating_today.max(pin_today));
        let today_done = dt;
        let today_remaining = (quota - dt).max(0);
        let today_target = quota.max(dt);

        rows.push(Row {
            t,
            pattern: ex.pattern,
            exercise_id: ex.id,
            exercise_name: &ex.name,
            remaining_week,
            today_target,
            today_done,
            today_remaining,
        });
    }

    // Per-pattern aggregation, in a stable push/pull/legs/core order.
    let mut patterns: Vec<PatternProgress> = Vec::new();
    for pat in [Pattern::Push, Pattern::Pull, Pattern::Legs, Pattern::Core] {
        let rs: Vec<&Row> = rows.iter().filter(|r| r.pattern == pat).collect();
        if rs.is_empty() {
            continue;
        }
        patterns.push(PatternProgress {
            pattern: pat,
            week_target: rs.iter().map(|r| r.t.target_sets).sum(),
            week_done: rs
                .iter()
                .map(|r| *done_week.get(&r.exercise_id).unwrap_or(&0))
                .sum(),
            today_target: rs.iter().map(|r| r.today_target).sum(),
            today_done: rs.iter().map(|r| r.today_done).sum(),
            today_remaining: rs.iter().map(|r| r.today_remaining).sum(),
        });
    }

    let day_remaining_sets: i32 = rows.iter().map(|r| r.today_remaining).sum();
    let week_remaining_sets: i32 = rows.iter().map(|r| r.remaining_week).sum();
    let day_target_total: i32 = rows.iter().map(|r| r.today_target).sum();
    let day_done_total: i32 = rows.iter().map(|r| r.today_done).sum();

    // Pick the exercise with the most remaining today (tie-break: pattern order,
    // then id) as the concrete suggestion.
    let mut best: Option<&Row> = None;
    for r in rows.iter().filter(|r| r.today_remaining > 0) {
        best = Some(match best {
            None => r,
            Some(b) => {
                let better = r.today_remaining > b.today_remaining
                    || (r.today_remaining == b.today_remaining
                        && pattern_rank(r.pattern) < pattern_rank(b.pattern))
                    || (r.today_remaining == b.today_remaining
                        && pattern_rank(r.pattern) == pattern_rank(b.pattern)
                        && r.exercise_id < b.exercise_id);
                if better { r } else { b }
            }
        });
    }
    let suggestion = best.map(|r| Suggestion {
        exercise_id: r.exercise_id,
        exercise_name: r.exercise_name.to_string(),
        pattern: r.pattern,
        sets: r.today_remaining,
        rep_low: r.t.rep_low,
        rep_high: r.t.rep_high,
        load_kg: r.t.load_kg,
        hold_s: r.t.hold_s,
    });

    // Burn-down: how far through the active window are we, and are we behind the
    // ideal pace? Being behind is what triggers a nudge — so nudges cluster
    // earlier when you're falling behind, never dumping the day at night.
    let now_min = (hour * 60 + now.minute() as i32) as f64;
    let win_start = (s.window_start_hour * 60) as f64;
    let win_end = (s.window_end_hour * 60).max(s.window_start_hour * 60 + 1) as f64;
    let progress = ((now_min - win_start) / (win_end - win_start)).clamp(0.0, 1.0);
    let has_work = day_remaining_sets > 0;
    let behind = has_work && (day_done_total as f64) < progress * (day_target_total as f64);

    let nudge = within_window && !after_cutoff && has_work && spacing_ok && behind;

    let reason = if !has_work {
        "You're done for today — nice work.".to_string()
    } else if after_cutoff {
        format!(
            "{} set{} left, but it's late — they'll roll to tomorrow.",
            day_remaining_sets,
            plural(day_remaining_sets)
        )
    } else if !within_window {
        format!(
            "Outside your training window ({:02}:00–{:02}:00).",
            s.window_start_hour, s.window_end_hour
        )
    } else if !spacing_ok {
        format!(
            "Just trained {}m ago — take a breather.",
            minutes_since_last_set.unwrap_or(0)
        )
    } else if let Some(sug) = &suggestion {
        if behind {
            format!(
                "{} set{} of {} — you're a bit behind for today.",
                sug.sets,
                plural(sug.sets),
                sug.exercise_name
            )
        } else {
            format!(
                "On track. Next up: {} × {} when you're ready.",
                sug.sets, sug.exercise_name
            )
        }
    } else {
        "On track.".to_string()
    };

    PacingNow {
        state: PacingState::Active,
        week_index: Some(week_index),
        is_deload,
        nudge,
        reason,
        within_window,
        after_cutoff,
        spacing_ok,
        minutes_since_last_set,
        day_remaining_sets,
        week_remaining_sets,
        patterns,
        suggestion,
    }
}

fn plural(n: i32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pacing::types::{
        ExerciseInfo, PacingSettings, PinInfo, ProgramInfo, SetInfo, TargetInfo,
    };
    use chrono::{NaiveDate, NaiveTime};

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
}
