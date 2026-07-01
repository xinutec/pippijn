//! Shopping list against a real MariaDB. Runs only when LIFE_TEST_DATABASE_URL
//! is set; skips otherwise.

use life::db;
use life::inventory::repo as inv_repo;
use life::inventory::types::{ItemCategory, NewItem};
use life::shopping::repo;
use life::shopping::types::{NewShoppingItem, UpdateShoppingItem};

#[tokio::test]
async fn shopping_crud_and_buy_against_real_db() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping shopping DB test");
        return;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    let user = "test-user-shopping";
    sqlx::query("DELETE FROM shopping_items WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM items WHERE user_id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    // Add a couple of things to buy.
    let yog = repo::create(
        &pool,
        user,
        NewShoppingItem {
            name: "Yoghurt".into(),
            quantity: Some(1.0),
            unit: Some("kg".into()),
            barcode: None,
        },
    )
    .await
    .unwrap();
    repo::create(
        &pool,
        user,
        NewShoppingItem {
            name: "Batteries".into(),
            quantity: None,
            unit: None,
            barcode: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(repo::list(&pool, user).await.unwrap().len(), 2);
    assert!(!yog.done);

    // Tick one off (done toggle via full update).
    let toggled = repo::update(
        &pool,
        user,
        yog.id,
        UpdateShoppingItem {
            name: yog.name.clone(),
            quantity: yog.quantity,
            unit: yog.unit.clone(),
            barcode: None,
            done: true,
        },
    )
    .await
    .unwrap()
    .expect("exists");
    assert!(toggled.done);

    // Buy it → becomes an inventory item, leaves the list (mirrors the route).
    let got = repo::get(&pool, user, yog.id).await.unwrap().unwrap();
    let item = inv_repo::create_item(
        &pool,
        user,
        NewItem {
            name: got.name,
            category: ItemCategory::Other,
            quantity: got.quantity,
            unit: got.unit,
            expiry: None,
            location_id: None,
            barcode: got.barcode,
        },
    )
    .await
    .unwrap();
    assert!(repo::delete(&pool, user, yog.id).await.unwrap());

    assert_eq!(item.name, "Yoghurt");
    assert_eq!(item.category, ItemCategory::Other);
    assert!(repo::get(&pool, user, yog.id).await.unwrap().is_none());
    assert_eq!(repo::list(&pool, user).await.unwrap().len(), 1); // Batteries remain
    assert_eq!(inv_repo::list_items(&pool, user).await.unwrap().len(), 1); // Yoghurt now owned
}
