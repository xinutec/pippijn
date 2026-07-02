//! The sync-conflict log against a real MariaDB. Runs only when
//! LIFE_TEST_DATABASE_URL is set; skips otherwise.

use life::conflicts::{ConflictKind, NewConflict, repo};
use life::db;

#[tokio::test]
async fn conflict_report_list_resolve_roundtrip() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping conflicts DB test");
        return;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    let user = "test-user-conflicts";
    sqlx::query("DELETE FROM sync_conflicts WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    let id = repo::create(
        &pool,
        user,
        NewConflict {
            kind: ConflictKind::Todo,
            ulid: "01HXAMPLETODOULID000000000".into(),
            field: "notes".into(),
            label: "Call the GP".into(),
            mine: "\"ask about MRI\"".into(),
            theirs: "\"ask about bloods\"".into(),
        },
    )
    .await
    .unwrap();

    // Listed, with JSON values intact.
    let listed = repo::list(&pool, user).await.unwrap();
    assert_eq!(listed.len(), 1);
    let entry = &listed[0];
    assert_eq!(entry.id, id);
    assert_eq!(entry.kind, ConflictKind::Todo);
    assert_eq!(entry.field, "notes");
    assert_eq!(entry.mine, "\"ask about MRI\"");
    assert_eq!(entry.theirs, "\"ask about bloods\"");

    // Resolve stamps it out of the list; the row is kept, not deleted.
    assert!(repo::resolve(&pool, user, id).await.unwrap());
    assert!(repo::list(&pool, user).await.unwrap().is_empty());
    assert!(
        !repo::resolve(&pool, user, id).await.unwrap(),
        "second resolve is a no-op"
    );
    let kept: Option<(u64,)> =
        sqlx::query_as("SELECT id FROM sync_conflicts WHERE id = ? AND resolved_at IS NOT NULL")
            .bind(id)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(kept.is_some(), "resolved rows are stamped, never deleted");

    // Another user cannot resolve someone else's entry.
    let id2 = repo::create(
        &pool,
        user,
        NewConflict {
            kind: ConflictKind::Shopping,
            ulid: "01HXAMPLESHOPULID000000000".into(),
            field: "quantity".into(),
            label: "Milk".into(),
            mine: "2".into(),
            theirs: "3".into(),
        },
    )
    .await
    .unwrap();
    assert!(!repo::resolve(&pool, "someone-else", id2).await.unwrap());
    assert_eq!(repo::list(&pool, user).await.unwrap().len(), 1);
}
