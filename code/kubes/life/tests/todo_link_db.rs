//! To-do connections against a real MariaDB. Runs only when LIFE_TEST_DATABASE_URL
//! is set; skips otherwise. Covers link CRUD (kinds + soft refs) and a sync
//! pull/push round-trip.

use life::db;
use life::sync::repo as sync_repo;
use life::sync::types::{PushEntry, TodoLinkDoc};
use life::todo::links;
use life::todo::types::{LinkKind, NewTodoLink, TargetKind};

#[tokio::test]
async fn todo_link_crud_and_sync_against_real_db() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping todo_link DB test");
        return;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    let user = "test-user-todo-link";
    sqlx::query("DELETE FROM todo_links WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    let from = "01TODOAAAAAAAAAAAAAAAAAAAA";

    // A depends-on link to another to-do, and a related link to an inventory item.
    let dep = links::create(
        &pool,
        user,
        NewTodoLink {
            from: from.into(),
            kind: LinkKind::DependsOn,
            target_kind: TargetKind::Todo,
            target_ref: "01TODOBBBBBBBBBBBBBBBBBBBB".into(),
        },
    )
    .await
    .unwrap();
    links::create(
        &pool,
        user,
        NewTodoLink {
            from: from.into(),
            kind: LinkKind::Related,
            target_kind: TargetKind::Item,
            target_ref: "42".into(),
        },
    )
    .await
    .unwrap();

    let all = links::list(&pool, user).await.unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(dep.kind, LinkKind::DependsOn);
    assert_eq!(dep.target_kind, TargetKind::Todo);
    assert_eq!(dep.from, from);

    // Delete one (soft).
    assert!(links::delete(&pool, user, dep.id).await.unwrap());
    assert_eq!(links::list(&pool, user).await.unwrap().len(), 1);

    // Sync pull includes the tombstone; push lands an offline-created link.
    let pulled = sync_repo::pull_todo_link(&pool, user, 0, 100)
        .await
        .unwrap();
    assert!(pulled.documents.iter().any(|d| d.deleted));

    let entry = PushEntry {
        new_document_state: TodoLinkDoc {
            ulid: "01LINKCCCCCCCCCCCCCCCCCCCC".into(),
            id: None,
            from: from.into(),
            kind: "subtask".into(),
            target_kind: "room".into(),
            target_ref: "kitchen".into(),
            deleted: false,
            rev: 0,
        },
        assumed_master_state: None,
    };
    let conflicts = sync_repo::push_todo_link(&pool, user, vec![entry])
        .await
        .unwrap();
    assert!(conflicts.is_empty());
    let after = links::list(&pool, user).await.unwrap();
    assert!(after.iter().any(|l| l.target_kind == TargetKind::Room
        && l.target_ref == "kitchen"
        && l.kind == LinkKind::Subtask));
}

/// Two offline devices adding the SAME connection (different ulids) must not
/// leave two live edges: the push-time twin guard lands the newcomer already
/// tombstoned, so the list shows one.
#[tokio::test]
async fn duplicate_edges_from_two_devices_are_deduped_on_push() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping todo_link dedupe test");
        return;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    let user = "test-user-todo-link-dupe";
    sqlx::query("DELETE FROM todo_links WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    let mk = |ulid: &str| PushEntry {
        new_document_state: TodoLinkDoc {
            ulid: ulid.into(),
            id: None,
            from: "01TODODUPEAAAAAAAAAAAAAAAA".into(),
            kind: "depends_on".into(),
            target_kind: "todo".into(),
            target_ref: "01TODOTARGETBBBBBBBBBBBBBB".into(),
            deleted: false,
            rev: 0,
        },
        assumed_master_state: None,
    };

    // Device A then device B push the semantically identical edge.
    sync_repo::push_todo_link(&pool, user, vec![mk("01LINKDEVICEA0000000000000")])
        .await
        .unwrap();
    sync_repo::push_todo_link(&pool, user, vec![mk("01LINKDEVICEB0000000000000")])
        .await
        .unwrap();

    // Exactly one live edge remains; the later ulid is the tombstoned one.
    let live = links::list(&pool, user).await.unwrap();
    assert_eq!(live.len(), 1, "duplicate edge should be tombstoned on push");

    // A boot-time dedupe pass leaves this user's single edge untouched (it runs
    // table-wide, so don't assert its global count under parallel tests).
    sync_repo::dedupe_todo_links(&pool).await.unwrap();
    assert_eq!(links::list(&pool, user).await.unwrap().len(), 1);
}
