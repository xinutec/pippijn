//! Restorable deletion against a real MariaDB: every delete tombstones, the
//! trash lists it, restore brings it back — and a sync push can NEVER clear a
//! tombstone (set-only; the trash restore is the one undelete path). Runs only
//! when LIFE_TEST_DATABASE_URL is set; skips otherwise.

use life::db;
use life::inventory::repo as inv_repo;
use life::inventory::types::{ItemCategory, LocationKind, NewItem, NewLocation};
use life::recipes::repo as recipes_repo;
use life::recipes::types::NewRecipe;
use life::shopping::repo as shopping_repo;
use life::shopping::types::NewShoppingItem;
use life::sync::repo as sync_repo;
use life::sync::types::PushEntry;
use life::trash::{TrashKind, repo as trash_repo};

async fn connect() -> Option<sqlx::MySqlPool> {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping trash DB test");
        return None;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    Some(pool)
}

async fn wipe(pool: &sqlx::MySqlPool, user: &str) {
    // Static SQL only (sqlx audits dynamic strings), one DELETE per table.
    for sql in [
        "DELETE FROM items WHERE user_id = ?",
        "DELETE FROM locations WHERE user_id = ?",
        "DELETE FROM recipes WHERE user_id = ?",
        "DELETE FROM shopping_items WHERE user_id = ?",
        "DELETE FROM todos WHERE user_id = ?",
    ] {
        sqlx::query(sql).bind(user).execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn item_delete_lists_in_trash_and_restores() {
    let Some(pool) = connect().await else { return };
    let user = "test-user-trash-item";
    wipe(&pool, user).await;

    let item = inv_repo::create_item(
        &pool,
        user,
        NewItem {
            name: "Trash test jar".into(),
            category: ItemCategory::Food,
            quantity: None,
            unit: None,
            expiry: None,
            location_id: None,
            barcode: None,
        },
    )
    .await
    .unwrap();

    assert!(inv_repo::delete_item(&pool, user, item.id).await.unwrap());
    // Hidden from reads, present in the trash.
    assert!(
        inv_repo::get_item(&pool, user, item.id)
            .await
            .unwrap()
            .is_none()
    );
    let trash = trash_repo::list(&pool, user).await.unwrap();
    assert!(
        trash
            .iter()
            .any(|e| e.kind == TrashKind::Item && e.ref_ == item.id.to_string()),
        "deleted item should appear in the trash"
    );

    // Restore brings it back; the trash entry disappears.
    assert!(
        trash_repo::restore(&pool, user, TrashKind::Item, &item.id.to_string())
            .await
            .unwrap()
    );
    assert!(
        inv_repo::get_item(&pool, user, item.id)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        !trash_repo::list(&pool, user)
            .await
            .unwrap()
            .iter()
            .any(|e| e.kind == TrashKind::Item)
    );
    // Restoring twice is a no-op.
    assert!(
        !trash_repo::restore(&pool, user, TrashKind::Item, &item.id.to_string())
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn location_delete_takes_subtree_and_restores_it() {
    let Some(pool) = connect().await else { return };
    let user = "test-user-trash-loc";
    wipe(&pool, user).await;

    let cupboard = inv_repo::create_location(
        &pool,
        user,
        NewLocation {
            kind: LocationKind::Cupboard,
            name: "Doomed cupboard".into(),
            parent_id: None,
            sort_order: 0,
            position: None,
        },
    )
    .await
    .unwrap();
    let shelf = inv_repo::create_location(
        &pool,
        user,
        NewLocation {
            kind: LocationKind::Layer,
            name: "Its shelf".into(),
            parent_id: Some(cupboard.id),
            sort_order: 0,
            position: None,
        },
    )
    .await
    .unwrap();
    let item = inv_repo::create_item(
        &pool,
        user,
        NewItem {
            name: "Jar on the shelf".into(),
            category: ItemCategory::Food,
            quantity: None,
            unit: None,
            expiry: None,
            location_id: Some(shelf.id),
            barcode: None,
        },
    )
    .await
    .unwrap();

    // Deleting the cupboard tombstones the shelf too; the item stays, still
    // pointing at its (hidden) shelf.
    assert!(
        inv_repo::delete_location(&pool, user, cupboard.id)
            .await
            .unwrap()
    );
    let visible = inv_repo::list_locations(&pool, user).await.unwrap();
    assert!(visible.is_empty(), "whole subtree should be hidden");
    let kept = inv_repo::get_item(&pool, user, item.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.location_id, Some(shelf.id), "item keeps its location");

    // Restoring the cupboard brings back the shelf (same delete stamp).
    assert!(
        trash_repo::restore(&pool, user, TrashKind::Location, &cupboard.id.to_string())
            .await
            .unwrap()
    );
    let visible = inv_repo::list_locations(&pool, user).await.unwrap();
    assert_eq!(visible.len(), 2, "cupboard + shelf both restored");
}

#[tokio::test]
async fn recipe_delete_and_restore_roundtrip() {
    let Some(pool) = connect().await else { return };
    let user = "test-user-trash-recipe";
    wipe(&pool, user).await;

    let recipe = recipes_repo::create_recipe(
        &pool,
        user,
        NewRecipe {
            name: "Binned bolognese".into(),
            instructions: None,
            servings: None,
            ingredients: vec![],
        },
    )
    .await
    .unwrap();

    assert!(
        recipes_repo::delete_recipe(&pool, user, recipe.id)
            .await
            .unwrap()
    );
    assert!(
        recipes_repo::get_recipe(&pool, user, recipe.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        trash_repo::restore(&pool, user, TrashKind::Recipe, &recipe.id.to_string())
            .await
            .unwrap()
    );
    let back = recipes_repo::get_recipe(&pool, user, recipe.id)
        .await
        .unwrap();
    assert_eq!(back.unwrap().name, "Binned bolognese");
}

#[tokio::test]
async fn sync_push_cannot_resurrect_a_tombstone_but_restore_can() {
    let Some(pool) = connect().await else { return };
    let user = "test-user-trash-sync";
    wipe(&pool, user).await;

    let created = shopping_repo::create(
        &pool,
        user,
        NewShoppingItem {
            name: "Zombie milk".into(),
            quantity: None,
            unit: None,
            barcode: None,
        },
    )
    .await
    .unwrap();
    assert!(
        shopping_repo::delete(&pool, user, created.id)
            .await
            .unwrap()
    );

    // Read the tombstoned doc (with its current rev) straight off the sync pull.
    let pulled = sync_repo::pull_shopping(&pool, user, 0, 100).await.unwrap();
    let doc = pulled
        .documents
        .iter()
        .find(|d| d.name == "Zombie milk")
        .expect("tombstone is pulled")
        .clone();
    assert!(doc.deleted);

    // A push with the CORRECT assumed rev and deleted=false — e.g. a buggy or
    // stale client — must NOT clear the tombstone.
    let mut undelete = doc.clone();
    undelete.deleted = false;
    let conflicts = sync_repo::push_shopping(
        &pool,
        user,
        vec![PushEntry {
            new_document_state: undelete,
            assumed_master_state: Some(doc.clone()),
        }],
    )
    .await
    .unwrap();
    assert!(
        conflicts.is_empty(),
        "the push itself is accepted (rev matched)"
    );
    let after = sync_repo::pull_shopping(&pool, user, 0, 100).await.unwrap();
    let after_doc = after
        .documents
        .iter()
        .find(|d| d.name == "Zombie milk")
        .unwrap();
    assert!(after_doc.deleted, "push must not resurrect a tombstone");

    // The explicit restore is the one deliberate undelete path — and it bumps
    // the rev so other devices pull the resurrected row.
    let rev_before = after_doc.rev;
    assert!(
        shopping_repo::restore(&pool, user, &doc.ulid)
            .await
            .unwrap()
    );
    let restored = sync_repo::pull_shopping(&pool, user, 0, 200).await.unwrap();
    let restored_doc = restored
        .documents
        .iter()
        .find(|d| d.name == "Zombie milk")
        .unwrap();
    assert!(!restored_doc.deleted);
    assert!(
        restored_doc.rev > rev_before,
        "restore must advance the rev"
    );
}
