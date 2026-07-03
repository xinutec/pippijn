//! Ingest + query against a real MariaDB. Runs only when VANTAGE_TEST_DATABASE_URL
//! is set (see scripts/dev-db.sh); skips otherwise so the default `cargo test`
//! needs no database. Covers validation, idempotent replay, the derived rollup,
//! and the overview/problems views.

use chrono::{Duration, Utc};
use vantage::report::repo;
use vantage::report::types::{CheckUpload, Freshness, ReportUpload, Verdict};
use ulid::Ulid;

mod common;

fn check(section: &str, label: &str, verdict: Verdict, value: Option<f64>) -> CheckUpload {
    CheckUpload {
        section: section.into(),
        label: label.into(),
        subject: None,
        verdict,
        observed: Some("obs".into()),
        expected: None,
        value,
        unit: value.map(|_| "%".into()),
        doc_ref: None,
        detail: None,
    }
}

#[tokio::test]
async fn ingest_idempotency_and_rollup() {
    let source = "test-ingest";
    let Some((pool, _guard)) = common::setup(source).await else {
        eprintln!("VANTAGE_TEST_DATABASE_URL unset — skipping ingest DB test");
        return;
    };

    let id = Ulid::new().to_string();
    let upload = ReportUpload {
        schema: 1,
        id: id.clone(),
        collector: "fleet-health".into(),
        collected_at: Utc::now(),
        duration_ms: Some(1234),
        interval_s: Some(3600),
        checks: vec![
            check("isis", "disk usage /", Verdict::Pass, Some(43.0)),
            check("isis", "cert days", Verdict::Warn, Some(12.0)),
            check("odin", "restic drill", Verdict::Fail, None),
        ],
    };

    let ack = repo::ingest(&pool, source, &upload, "{}")
        .await
        .expect("ingest");
    assert!(!ack.duplicate);
    assert_eq!(ack.checks, 3);

    // Replaying the same id is a no-op (idempotent spool retry).
    let again = repo::ingest(&pool, source, &upload, "{}")
        .await
        .expect("replay");
    assert!(again.duplicate);
    assert_eq!(again.checks, 0);

    // Exactly one report and three checks stored (no duplication).
    let (reports,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM report WHERE source = ?")
        .bind(source)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(reports, 1);
    let (checks,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM check_result WHERE source = ?")
        .bind(source)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(checks, 3);

    // Overview: worst = Fail (one failing check), counts add up, Fresh (age ~0).
    let entry = repo::overview(&pool)
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.source == source)
        .expect("overview entry present");
    assert_eq!(entry.worst, Verdict::Fail);
    assert_eq!(
        (entry.pass, entry.warn, entry.fail, entry.skip),
        (1, 1, 1, 0)
    );
    assert_eq!(entry.total, 3);
    assert_eq!(entry.freshness, Freshness::Fresh);
    assert_eq!(entry.report_id, id);

    // Problems: the fail + warn checks surface, fail ordered first.
    let problems = repo::problems(&pool).await.unwrap();
    let mine: Vec<_> = problems
        .checks
        .iter()
        .filter(|c| c.source == source)
        .collect();
    assert_eq!(mine.len(), 2);
    assert_eq!(mine[0].verdict, Verdict::Fail);
    assert_eq!(mine[0].label, "restic drill");
    assert_eq!(mine[1].verdict, Verdict::Warn);

    // Report detail round-trips all three checks in order.
    let detail = repo::report_detail(&pool, &id)
        .await
        .unwrap()
        .expect("detail");
    assert_eq!(detail.collector, "fleet-health");
    assert!(!detail.ok); // has a fail
    assert_eq!(detail.checks.len(), 3);
    assert_eq!(detail.checks[0].label, "disk usage /");

    common::clean(&pool, source).await;
}

#[tokio::test]
async fn rejects_bad_schema_and_ulid() {
    let Some((pool, _guard)) = common::setup("test-bad").await else {
        eprintln!("VANTAGE_TEST_DATABASE_URL unset — skipping validation DB test");
        return;
    };

    let mut upload = ReportUpload {
        schema: 999,
        id: Ulid::new().to_string(),
        collector: "x".into(),
        collected_at: Utc::now(),
        duration_ms: None,
        interval_s: None,
        checks: vec![],
    };
    assert!(
        repo::ingest(&pool, "test-bad", &upload, "{}")
            .await
            .is_err()
    );

    upload.schema = 1;
    upload.id = "not-a-ulid".into();
    assert!(
        repo::ingest(&pool, "test-bad", &upload, "{}")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn stale_collector_surfaces_in_problems() {
    let source = "test-stale";
    let Some((pool, _guard)) = common::setup(source).await else {
        eprintln!("VANTAGE_TEST_DATABASE_URL unset — skipping staleness DB test");
        return;
    };

    // A report collected 5h ago with an hourly interval → Silent (> 3×).
    let upload = ReportUpload {
        schema: 1,
        id: Ulid::new().to_string(),
        collector: "fleet-health".into(),
        collected_at: Utc::now() - Duration::hours(5),
        duration_ms: None,
        interval_s: Some(3600),
        checks: vec![check("h", "all good", Verdict::Pass, None)],
    };
    repo::ingest(&pool, source, &upload, "{}").await.unwrap();

    let problems = repo::problems(&pool).await.unwrap();
    let stale = problems
        .stale
        .iter()
        .find(|e| e.source == source)
        .expect("silent collector in stale list");
    assert_eq!(stale.freshness, Freshness::Silent);

    common::clean(&pool, source).await;
}
