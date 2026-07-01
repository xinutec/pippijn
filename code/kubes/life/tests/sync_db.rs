//! Offline-first sync (shopping) against a real MariaDB. Runs only when
//! LIFE_TEST_DATABASE_URL is set; skips otherwise.

use life::db;
use life::shopping::repo as shop;
use life::shopping::types::NewShoppingItem;
use life::sync::repo as sync;
use life::sync::types::{PushEntry, ShoppingDoc};
use ulid::Ulid;

fn doc(ulid: &str, name: &str, rev: u64) -> ShoppingDoc {
    ShoppingDoc {
        ulid: ulid.to_string(),
        id: None,
        name: name.to_string(),
        quantity: None,
        unit: None,
        barcode: None,
        done: false,
        deleted: false,
        rev,
    }
}

#[tokio::test]
async fn shopping_sync_pull_push_conflict_tombstone() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping sync DB test");
        return;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    let user = "test-user-sync";
    sqlx::query("DELETE FROM shopping_items WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    // A legacy create is rev-aware → it shows up in a full pull (since 0).
    let milk = shop::create(
        &pool,
        user,
        NewShoppingItem {
            name: "Milk".into(),
            quantity: Some(2.0),
            unit: Some("L".into()),
            barcode: None,
        },
    )
    .await
    .unwrap();

    let p1 = sync::pull_shopping(&pool, user, 0, 100).await.unwrap();
    assert_eq!(p1.documents.len(), 1);
    let m = p1.documents[0].clone();
    assert_eq!(m.name, "Milk");
    assert!(!m.deleted);
    assert!(m.rev > 0);
    assert_eq!(p1.checkpoint.rev, m.rev);

    // Pulling from the checkpoint yields nothing new.
    let p2 = sync::pull_shopping(&pool, user, p1.checkpoint.rev, 100)
        .await
        .unwrap();
    assert!(p2.documents.is_empty());
    assert_eq!(p2.checkpoint.rev, p1.checkpoint.rev);

    // Push a fresh client-created doc (no assumed master) → inserted, no conflict.
    let eggs_ulid = Ulid::new().to_string();
    let conflicts = sync::push_shopping(
        &pool,
        user,
        vec![PushEntry {
            new_document_state: doc(&eggs_ulid, "Eggs", 0),
            assumed_master_state: None,
        }],
    )
    .await
    .unwrap();
    assert!(conflicts.is_empty());
    let p3 = sync::pull_shopping(&pool, user, p2.checkpoint.rev, 100)
        .await
        .unwrap();
    assert!(p3.documents.iter().any(|d| d.name == "Eggs" && !d.deleted));

    // Stale update of Milk (wrong assumed rev) → rejected; the current master is
    // returned so the client can resolve.
    let stale = sync::push_shopping(
        &pool,
        user,
        vec![PushEntry {
            new_document_state: doc(&m.ulid, "Milk 2%", 0),
            assumed_master_state: Some(doc(&m.ulid, "Milk", m.rev - 1)),
        }],
    )
    .await
    .unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].ulid, m.ulid);
    assert_eq!(stale[0].rev, m.rev); // unchanged — the stale write was not applied
    assert_eq!(stale[0].name, "Milk");

    // Correct assumed rev → accepted.
    let ok = sync::push_shopping(
        &pool,
        user,
        vec![PushEntry {
            new_document_state: doc(&m.ulid, "Milk 2%", 0),
            assumed_master_state: Some(doc(&m.ulid, "Milk", m.rev)),
        }],
    )
    .await
    .unwrap();
    assert!(ok.is_empty());
    let after = sync::pull_shopping(&pool, user, 0, 100).await.unwrap();
    let m2 = after.documents.iter().find(|d| d.ulid == m.ulid).unwrap();
    assert_eq!(m2.name, "Milk 2%");
    assert!(m2.rev > m.rev); // a new revision was assigned

    // A legacy soft-delete surfaces as a tombstone in pull, and hides from list.
    assert!(shop::delete(&pool, user, milk.id).await.unwrap());
    let final_pull = sync::pull_shopping(&pool, user, 0, 100).await.unwrap();
    let tomb = final_pull
        .documents
        .iter()
        .find(|d| d.ulid == m.ulid)
        .unwrap();
    assert!(tomb.deleted);
    assert!(
        shop::list(&pool, user)
            .await
            .unwrap()
            .iter()
            .all(|s| s.id != milk.id)
    );
}
