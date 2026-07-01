//! Product cache against a real MariaDB (no Open Food Facts call — pure cache
//! layer). Runs only when LIFE_TEST_DATABASE_URL is set.

use life::db;
use life::products::repo;

#[tokio::test]
async fn product_cache_against_real_db() {
    let Ok(url) = std::env::var("LIFE_TEST_DATABASE_URL") else {
        eprintln!("LIFE_TEST_DATABASE_URL unset — skipping products DB test");
        return;
    };
    let pool = db::connect(&url).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");

    let bc = "test-barcode-0001";
    sqlx::query("DELETE FROM products WHERE barcode = ?")
        .bind(bc)
        .execute(&pool)
        .await
        .unwrap();

    // Miss.
    assert!(repo::get(&pool, bc).await.unwrap().is_none());

    // Cache with an image.
    repo::upsert(
        &pool,
        bc,
        Some("Test Yog"),
        Some("BrandX"),
        Some("950g"),
        Some((vec![1, 2, 3, 4], "image/png".into())),
    )
    .await
    .unwrap();
    let p = repo::get(&pool, bc).await.unwrap().expect("cached");
    assert_eq!(p.name.as_deref(), Some("Test Yog"));
    assert_eq!(p.quantity_label.as_deref(), Some("950g"));
    assert!(p.has_image);

    let (bytes, mime) = repo::get_image(&pool, bc).await.unwrap().expect("image");
    assert_eq!(bytes, vec![1, 2, 3, 4]);
    assert_eq!(mime, "image/png");

    // Re-cache without an image overwrites in place.
    repo::upsert(&pool, bc, Some("Test Yog 2"), None, None, None)
        .await
        .unwrap();
    let p2 = repo::get(&pool, bc).await.unwrap().expect("cached");
    assert_eq!(p2.name.as_deref(), Some("Test Yog 2"));
    assert!(!p2.has_image);

    // A user upload replaces ONLY the image, leaving metadata untouched.
    repo::set_image(&pool, bc, &[9, 8, 7], "image/webp")
        .await
        .unwrap();
    let p3 = repo::get(&pool, bc).await.unwrap().expect("cached");
    assert_eq!(p3.name.as_deref(), Some("Test Yog 2"), "name preserved");
    assert!(p3.has_image);
    let (bytes, mime) = repo::get_image(&pool, bc).await.unwrap().expect("image");
    assert_eq!(bytes, vec![9, 8, 7]);
    assert_eq!(mime, "image/webp");

    // set_image on an unknown barcode creates a bare catalog row with the image.
    let fresh = "test-barcode-upload-only";
    sqlx::query("DELETE FROM products WHERE barcode = ?")
        .bind(fresh)
        .execute(&pool)
        .await
        .unwrap();
    repo::set_image(&pool, fresh, &[1], "image/png")
        .await
        .unwrap();
    let pf = repo::get(&pool, fresh).await.unwrap().expect("created");
    assert!(pf.name.is_none(), "no metadata, just an image");
    assert!(pf.has_image);
}
