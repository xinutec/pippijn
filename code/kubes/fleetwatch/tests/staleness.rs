//! Pure unit tests for the staleness bands — no DB, no clock. The freshness
//! computation is load-bearing (a dead producer must not look green), so its
//! boundaries are pinned exactly.

use fleetwatch::report::staleness::freshness;
use fleetwatch::report::types::Freshness;

#[test]
fn hourly_bands() {
    // interval 3600: Fresh ≤ 1.5×(5400), Overdue ≤ 3×(10800), else Silent.
    assert_eq!(freshness(0, Some(3600)), Freshness::Fresh);
    assert_eq!(freshness(5400, Some(3600)), Freshness::Fresh); // exactly 1.5×
    assert_eq!(freshness(5401, Some(3600)), Freshness::Overdue);
    assert_eq!(freshness(10800, Some(3600)), Freshness::Overdue); // exactly 3×
    assert_eq!(freshness(10801, Some(3600)), Freshness::Silent);
}

#[test]
fn absent_interval_assumes_hourly() {
    assert_eq!(freshness(100, None), Freshness::Fresh);
    assert_eq!(freshness(20000, None), Freshness::Silent);
}

#[test]
fn six_hourly_bands() {
    let six_h = 6 * 3600;
    assert_eq!(freshness(six_h, Some(six_h as u64)), Freshness::Fresh); // 1× is fresh
    assert_eq!(
        freshness(3 * six_h + 1, Some(six_h as u64)),
        Freshness::Silent
    );
}

#[test]
fn zero_interval_is_floored_not_divided_by_zero() {
    // A degenerate interval must not panic or make everything Fresh.
    assert_eq!(freshness(10, Some(0)), Freshness::Silent);
}
