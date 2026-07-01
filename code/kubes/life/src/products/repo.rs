//! Persistence for the product cache.

use anyhow::Result;
use sqlx::MySqlPool;

use super::types::Product;

#[derive(sqlx::FromRow)]
struct MetaRow {
    id: u64,
    barcode: Option<String>,
    name: Option<String>,
    brand: Option<String>,
    quantity_label: Option<String>,
    has_image: i64,
}

/// Cached metadata for a barcode (no image bytes), or None if not cached.
pub async fn get(pool: &MySqlPool, barcode: &str) -> Result<Option<Product>> {
    let row: Option<MetaRow> = sqlx::query_as(
        "SELECT id, barcode, name, brand, quantity_label, (image IS NOT NULL) AS has_image \
         FROM products WHERE barcode = ?",
    )
    .bind(barcode)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| Product {
        id: r.id,
        barcode: r.barcode,
        name: r.name,
        brand: r.brand,
        quantity_label: r.quantity_label,
        has_image: r.has_image != 0,
    }))
}

/// Cached image bytes + mime for a barcode, if present.
pub async fn get_image(pool: &MySqlPool, barcode: &str) -> Result<Option<(Vec<u8>, String)>> {
    let row: Option<(Option<Vec<u8>>, Option<String>)> =
        sqlx::query_as("SELECT image, image_mime FROM products WHERE barcode = ?")
            .bind(barcode)
            .fetch_optional(pool)
            .await?;
    Ok(match row {
        Some((Some(bytes), mime)) => Some((bytes, mime.unwrap_or_else(|| "image/jpeg".into()))),
        _ => None,
    })
}

/// Replace just the image bytes for a barcode, leaving name/brand/quantity as
/// they are. Creates a bare catalog row if the barcode was never looked up (so
/// you can give an image to a product OFF has never heard of); `source='user'`
/// marks a hand-uploaded image, but only on insert — a later OFF metadata
/// refresh keeps its own `source`. The unique `barcode` key drives the upsert.
pub async fn set_image(pool: &MySqlPool, barcode: &str, bytes: &[u8], mime: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO products (barcode, image, image_mime, source) \
         VALUES (?, ?, ?, 'user') \
         ON DUPLICATE KEY UPDATE image = VALUES(image), \
         image_mime = VALUES(image_mime), fetched_at = CURRENT_TIMESTAMP",
    )
    .bind(barcode)
    .bind(bytes)
    .bind(mime)
    .execute(pool)
    .await?;
    Ok(())
}

/// Insert or refresh a cached product (with optional image).
pub async fn upsert(
    pool: &MySqlPool,
    barcode: &str,
    name: Option<&str>,
    brand: Option<&str>,
    quantity_label: Option<&str>,
    image: Option<(Vec<u8>, String)>,
) -> Result<()> {
    let (bytes, mime) = match image {
        Some((b, m)) => (Some(b), Some(m)),
        None => (None, None),
    };
    sqlx::query(
        "INSERT INTO products (barcode, name, brand, quantity_label, image, image_mime, source) \
         VALUES (?, ?, ?, ?, ?, ?, 'off') \
         ON DUPLICATE KEY UPDATE name = VALUES(name), brand = VALUES(brand), \
         quantity_label = VALUES(quantity_label), image = VALUES(image), \
         image_mime = VALUES(image_mime), fetched_at = CURRENT_TIMESTAMP",
    )
    .bind(barcode)
    .bind(name)
    .bind(brand)
    .bind(quantity_label)
    .bind(&bytes)
    .bind(&mime)
    .execute(pool)
    .await?;
    Ok(())
}
