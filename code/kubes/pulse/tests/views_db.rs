//! History + report-listing queries against a real MariaDB. Gated on
//! PULSE_TEST_DATABASE_URL like the other DB tests.

use chrono::{Duration, Utc};
use pulse::report::repo;
use pulse::report::types::{CheckUpload, ReportUpload, Verdict};
use ulid::Ulid;

mod common;

fn numeric_check(value: f64, verdict: Verdict) -> CheckUpload {
    CheckUpload {
        section: "isis".into(),
        label: "disk usage /".into(),
        subject: Some("isis".into()),
        verdict,
        observed: Some(format!("{value}% used")),
        expected: Some("< 85%".into()),
        value: Some(value),
        unit: Some("%".into()),
        doc_ref: None,
        detail: None,
    }
}

#[tokio::test]
async fn history_and_runs_time_series() {
    let source = "test-views";
    let Some((pool, _guard)) = common::setup(source).await else {
        eprintln!("PULSE_TEST_DATABASE_URL unset — skipping views DB test");
        return;
    };

    // Three runs of the same collector over three hours, disk creeping up.
    let now = Utc::now();
    for (h, disk) in [(2i64, 40.0), (1, 50.0), (0, 91.0)] {
        let verdict = if disk > 85.0 {
            Verdict::Fail
        } else {
            Verdict::Pass
        };
        let upload = ReportUpload {
            schema: 1,
            id: Ulid::new().to_string(),
            collector: "fleet-health".into(),
            collected_at: now - Duration::hours(h),
            duration_ms: Some(1000),
            interval_s: Some(3600),
            checks: vec![numeric_check(disk, verdict)],
        };
        repo::ingest(&pool, source, &upload, "{}").await.unwrap();
    }

    // Runs list: three reports, newest first, latest is not-ok (disk failed).
    let runs = repo::list_reports(&pool, Some(source), None, 100)
        .await
        .unwrap();
    assert_eq!(runs.len(), 3);
    assert!(!runs[0].ok);
    assert!(runs[2].ok);

    // History for the disk check: three ascending points, unit carried through.
    let hist = repo::history(
        &pool,
        source,
        "fleet-health",
        "isis",
        "disk usage /",
        now - Duration::days(1),
        now + Duration::minutes(1),
    )
    .await
    .unwrap();
    assert_eq!(hist.points.len(), 3);
    assert_eq!(hist.unit.as_deref(), Some("%"));
    let values: Vec<f64> = hist.points.iter().filter_map(|p| p.value).collect();
    assert_eq!(values, vec![40.0, 50.0, 91.0]);
    assert_eq!(hist.points[2].verdict, Verdict::Fail);

    common::clean(&pool, source).await;
}
