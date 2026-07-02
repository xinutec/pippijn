//! Integration test against a real MariaDB. Runs only when
//! LIFE_TEST_DATABASE_URL is set (see scripts/dev-db.sh); skips otherwise so
//! the default `cargo test` needs no database.

use life::db;
use life::inventory::repo;
use life::inventory::types::{ItemCategory, LocationKind, NewItem, NewLocation};

fn loc(kind: LocationKind, name: &str, parent: Option<u64>, sort_order: i32) -> NewLocation {
    NewLocation {
        kind,
        name: name.into(),
        parent_id: parent,
        sort_order,
        position: None,
    }
}

#[tokio::test]
async fn inventory_crud_against_real_db() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping DB integration test");
        return;
    };

    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    // Isolate this test's rows.
    let user = "test-user-inventory";
    sqlx::query("DELETE FROM items WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM locations WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    // Build house → kitchen → cupboard → top shelf.
    let house = repo::create_location(&pool, user, loc(LocationKind::House, "Home", None, 0))
        .await
        .unwrap();
    let kitchen = repo::create_location(
        &pool,
        user,
        loc(LocationKind::Room, "Kitchen", Some(house.id), 0),
    )
    .await
    .unwrap();
    let cupboard = repo::create_location(
        &pool,
        user,
        loc(LocationKind::Cupboard, "Spice", Some(kitchen.id), 0),
    )
    .await
    .unwrap();
    let shelf = repo::create_location(
        &pool,
        user,
        loc(LocationKind::Layer, "Top", Some(cupboard.id), 1),
    )
    .await
    .unwrap();

    // Put an item on the top shelf.
    let item = repo::create_item(
        &pool,
        user,
        NewItem {
            name: "Cumin".into(),
            category: ItemCategory::Food,
            quantity: Some(1.0),
            unit: Some("jar".into()),
            expiry: None,
            location_id: Some(shelf.id),
            barcode: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(item.location_id, Some(shelf.id));
    assert_eq!(item.category, ItemCategory::Food);

    // Move it to the kitchen.
    let moved = repo::move_item(&pool, user, item.id, Some(kitchen.id))
        .await
        .unwrap()
        .expect("item exists");
    assert_eq!(moved.location_id, Some(kitchen.id));

    // Moving a non-existent item yields None, not an error.
    assert!(
        repo::move_item(&pool, user, 99_999_999, None)
            .await
            .unwrap()
            .is_none()
    );

    // History recorded both the add and the move.
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM item_history WHERE item_id = ?")
        .bind(item.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);

    // Update every field (name + quantity).
    let updated = repo::update_item(
        &pool,
        user,
        item.id,
        NewItem {
            name: "Ground cumin".into(),
            category: ItemCategory::Food,
            quantity: Some(2.0),
            unit: Some("jar".into()),
            expiry: None,
            location_id: Some(kitchen.id),
            barcode: None,
        },
    )
    .await
    .unwrap()
    .expect("item exists");
    assert_eq!(updated.name, "Ground cumin");
    assert_eq!(updated.quantity, Some(2.0));

    // Delete the item; gone afterwards.
    assert!(repo::delete_item(&pool, user, item.id).await.unwrap());
    assert!(
        repo::get_item(&pool, user, item.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!repo::delete_item(&pool, user, item.id).await.unwrap());

    // Delete a location.
    assert!(repo::delete_location(&pool, user, shelf.id).await.unwrap());
    assert!(!repo::delete_location(&pool, user, shelf.id).await.unwrap());
}
