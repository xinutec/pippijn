//! Wellbeing check-ins against a real MariaDB. Runs only when
//! LIFE_TEST_DATABASE_URL is set; skips otherwise. Covers the sync pull/push
//! round-trip (offline insert → pull → update → stale-conflict → tombstone) plus
//! the trash restore.

use chrono::{TimeZone, Utc};
use life::db;
use life::sync::repo as sync_repo;
use life::sync::types::{PushEntry, WellbeingDoc};
use life::wellbeing::repo as wellbeing_repo;

fn doc(ulid: &str, score: u8, rev: u64, deleted: bool) -> WellbeingDoc {
    WellbeingDoc {
        ulid: ulid.into(),
        id: None,
        recorded_at: Utc.with_ymd_and_hms(2026, 7, 3, 9, 30, 0).unwrap(),
        score,
        note: Some("felt low".into()),
        deleted,
        rev,
    }
}

#[tokio::test]
async fn wellbeing_sync_and_restore_against_real_db() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping wellbeing DB test");
        return;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    let user = "test-user-wellbeing";
    sqlx::query("DELETE FROM wellbeing WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    let ulid = "0123456789ABCDEFGHJKMNPQRS";

    // Offline-created check-in lands on the server (no assumed master state).
    let conflicts = sync_repo::push_wellbeing(
        &pool,
        user,
        vec![PushEntry {
            new_document_state: doc(ulid, 2, 0, false),
            assumed_master_state: None,
        }],
    )
    .await
    .unwrap();
    assert!(conflicts.is_empty());

    // Pull surfaces it with a server id + rev; the timestamp round-trips as UTC.
    let pulled = sync_repo::pull_wellbeing(&pool, user, 0, 100)
        .await
        .unwrap();
    let got = pulled
        .documents
        .iter()
        .find(|d| d.ulid == ulid)
        .expect("present");
    assert_eq!(got.score, 2);
    assert_eq!(
        got.recorded_at,
        Utc.with_ymd_and_hms(2026, 7, 3, 9, 30, 0).unwrap()
    );
    let server_rev = got.rev;

    // Update with the correct assumed rev is accepted; a stale one conflicts.
    let stale = sync_repo::push_wellbeing(
        &pool,
        user,
        vec![PushEntry {
            new_document_state: doc(ulid, 5, 0, false),
            assumed_master_state: Some(doc(ulid, 2, server_rev - 1, false)), // wrong rev
        }],
    )
    .await
    .unwrap();
    assert_eq!(stale.len(), 1, "stale push is rejected as a conflict");

    let ok = sync_repo::push_wellbeing(
        &pool,
        user,
        vec![PushEntry {
            new_document_state: doc(ulid, 5, 0, false),
            assumed_master_state: Some(doc(ulid, 2, server_rev, false)),
        }],
    )
    .await
    .unwrap();
    assert!(ok.is_empty());
    let after = sync_repo::pull_wellbeing(&pool, user, 0, 100)
        .await
        .unwrap();
    assert_eq!(
        after
            .documents
            .iter()
            .find(|d| d.ulid == ulid)
            .unwrap()
            .score,
        5
    );

    // Tombstone via push, then the explicit trash restore brings it back.
    let cur = after.documents.iter().find(|d| d.ulid == ulid).unwrap().rev;
    sync_repo::push_wellbeing(
        &pool,
        user,
        vec![PushEntry {
            new_document_state: doc(ulid, 5, 0, true),
            assumed_master_state: Some(doc(ulid, 5, cur, false)),
        }],
    )
    .await
    .unwrap();
    let deleted = sync_repo::pull_wellbeing(&pool, user, 0, 100)
        .await
        .unwrap();
    assert!(
        deleted
            .documents
            .iter()
            .find(|d| d.ulid == ulid)
            .unwrap()
            .deleted
    );

    assert!(wellbeing_repo::restore(&pool, user, ulid).await.unwrap());
    let restored = sync_repo::pull_wellbeing(&pool, user, 0, 100)
        .await
        .unwrap();
    assert!(
        !restored
            .documents
            .iter()
            .find(|d| d.ulid == ulid)
            .unwrap()
            .deleted
    );
}
