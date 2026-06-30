//! To-do list against a real MariaDB. Runs only when LIFE_TEST_DATABASE_URL is
//! set; skips otherwise. Covers repo CRUD (types + status + soft-delete) and a
//! sync pull/push round-trip (the offline path).

use life::db;
use life::sync::repo as sync_repo;
use life::sync::types::{PushEntry, TodoDoc};
use life::todo::repo;
use life::todo::types::{NewTodo, TodoStatus, TodoType, UpdateTodo};

#[tokio::test]
async fn todo_crud_and_sync_against_real_db() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping todo DB test");
        return;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    let user = "test-user-todo";
    sqlx::query("DELETE FROM todos WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    // Create two typed to-dos.
    let milk = repo::create(
        &pool,
        user,
        NewTodo { title: "Buy milk".into(), todo_type: TodoType::Purchase, notes: None },
    )
    .await
    .unwrap();
    repo::create(
        &pool,
        user,
        NewTodo {
            title: "Call dentist".into(),
            todo_type: TodoType::Call,
            notes: Some("re-book cleaning".into()),
        },
    )
    .await
    .unwrap();

    let all = repo::list(&pool, user).await.unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(milk.status, TodoStatus::Open);
    assert_eq!(milk.todo_type, TodoType::Purchase);

    // Update: mark done, keep the type, change notes.
    let done = repo::update(
        &pool,
        user,
        milk.id,
        UpdateTodo {
            title: milk.title.clone(),
            todo_type: TodoType::Purchase,
            status: TodoStatus::Done,
            notes: Some("got oat milk".into()),
        },
    )
    .await
    .unwrap()
    .expect("exists");
    assert_eq!(done.status, TodoStatus::Done);
    assert_eq!(done.notes.as_deref(), Some("got oat milk"));

    // Soft delete hides it from reads.
    assert!(repo::delete(&pool, user, milk.id).await.unwrap());
    let after = repo::list(&pool, user).await.unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].title, "Call dentist");

    // Sync pull surfaces every row including the tombstone, in rev order.
    let pulled = sync_repo::pull_todo(&pool, user, 0, 100).await.unwrap();
    assert!(pulled.documents.iter().any(|d| d.title == "Buy milk" && d.deleted));
    assert!(pulled.documents.iter().any(|d| d.title == "Call dentist" && !d.deleted));

    // Sync push: a to-do created offline (client-minted ulid) lands on the server.
    let entry = PushEntry {
        new_document_state: TodoDoc {
            ulid: "0123456789ABCDEFGHJKMNPQRS".into(),
            id: None,
            title: "Pay rent".into(),
            todo_type: "call".into(),
            status: "open".into(),
            notes: None,
            deleted: false,
            rev: 0,
        },
        assumed_master_state: None,
    };
    let conflicts = sync_repo::push_todo(&pool, user, vec![entry]).await.unwrap();
    assert!(conflicts.is_empty());
    let after_push = repo::list(&pool, user).await.unwrap();
    assert!(after_push.iter().any(|t| t.title == "Pay rent" && t.todo_type == TodoType::Call));
}
