//! Persistence for locations and items. `position` is stored as JSON text and
//! parsed here, so it survives however MariaDB reports the JSON column type.

use std::str::FromStr;

use anyhow::{Context, Result, anyhow};
use chrono::NaiveDate;
use sqlx::MySqlPool;

use super::types::{Item, ItemCategory, Location, LocationKind, NewItem, NewLocation};

#[derive(sqlx::FromRow)]
struct LocationRow {
    id: u64,
    kind: String,
    name: String,
    parent_id: Option<u64>,
    sort_order: i32,
    position: Option<String>,
}

impl LocationRow {
    fn into_location(self) -> Result<Location> {
        let kind = LocationKind::from_str(&self.kind).map_err(|e| anyhow!(e))?;
        let position = match self.position {
            Some(s) => Some(serde_json::from_str(&s).context("parsing location.position")?),
            None => None,
        };
        Ok(Location {
            id: self.id,
            kind,
            name: self.name,
            parent_id: self.parent_id,
            sort_order: self.sort_order,
            position,
        })
    }
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: u64,
    product_id: Option<u64>,
    name: String,
    brand: Option<String>,
    category: String,
    quantity: Option<f64>,
    unit: Option<String>,
    expiry: Option<NaiveDate>,
    location_id: Option<u64>,
    barcode: Option<String>,
    // A boolean SQL expression decodes as an integer.
    has_image: i64,
}

impl ItemRow {
    fn into_item(self) -> Result<Item> {
        let category = ItemCategory::from_str(&self.category).map_err(|e| anyhow!(e))?;
        Ok(Item {
            id: self.id,
            product_id: self.product_id,
            name: self.name,
            brand: self.brand,
            category,
            quantity: self.quantity,
            unit: self.unit,
            expiry: self.expiry,
            location_id: self.location_id,
            barcode: self.barcode,
            has_image: self.has_image != 0,
        })
    }
}

/// The resolved item read: holding fields from `items`, display fields
/// (name/brand/barcode/image) resolved against the linked catalog product. A
/// macro (not a const) so it stays a compile-time literal — sqlx rejects
/// runtime-built query strings.
macro_rules! item_select {
    () => {
        "SELECT i.id AS id, i.product_id AS product_id, \
         COALESCE(p.name, i.name, '') AS name, p.brand AS brand, i.category AS category, \
         i.quantity AS quantity, i.unit AS unit, i.expiry AS expiry, i.location_id AS location_id, \
         COALESCE(i.barcode, p.barcode) AS barcode, (p.image IS NOT NULL) AS has_image \
         FROM items i LEFT JOIN products p ON p.id = i.product_id"
    };
}

/// Resolve the catalog product id for a barcode, if one is cached.
async fn product_id_for_barcode(pool: &MySqlPool, barcode: Option<&str>) -> Result<Option<u64>> {
    let Some(bc) = barcode else { return Ok(None) };
    let row: Option<(u64,)> = sqlx::query_as("SELECT id FROM products WHERE barcode = ?")
        .bind(bc)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.0))
}

pub async fn list_locations(pool: &MySqlPool, user_id: &str) -> Result<Vec<Location>> {
    let rows: Vec<LocationRow> = sqlx::query_as(
        "SELECT id, kind, name, parent_id, sort_order, position FROM locations \
         WHERE user_id = ? ORDER BY parent_id, sort_order, id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(LocationRow::into_location).collect()
}

pub async fn create_location(
    pool: &MySqlPool,
    user_id: &str,
    new: NewLocation,
) -> Result<Location> {
    let position_str = match &new.position {
        Some(v) => Some(serde_json::to_string(v)?),
        None => None,
    };
    let res = sqlx::query(
        "INSERT INTO locations (user_id, kind, name, parent_id, sort_order, position) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(new.kind.to_string())
    .bind(&new.name)
    .bind(new.parent_id)
    .bind(new.sort_order)
    .bind(&position_str)
    .execute(pool)
    .await?;
    Ok(Location {
        id: res.last_insert_id(),
        kind: new.kind,
        name: new.name,
        parent_id: new.parent_id,
        sort_order: new.sort_order,
        position: new.position,
    })
}

pub async fn list_items(pool: &MySqlPool, user_id: &str) -> Result<Vec<Item>> {
    let rows: Vec<ItemRow> =
        sqlx::query_as(concat!(item_select!(), " WHERE i.user_id = ? ORDER BY name"))
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    rows.into_iter().map(ItemRow::into_item).collect()
}

pub async fn search_items(pool: &MySqlPool, user_id: &str, query: &str) -> Result<Vec<Item>> {
    let pattern = format!("%{query}%");
    let rows: Vec<ItemRow> = sqlx::query_as(concat!(
        item_select!(),
        " WHERE i.user_id = ? AND COALESCE(p.name, i.name, '') LIKE ? ORDER BY name"
    ))
    .bind(user_id)
    .bind(pattern)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(ItemRow::into_item).collect()
}

pub async fn get_item(pool: &MySqlPool, user_id: &str, id: u64) -> Result<Option<Item>> {
    let row: Option<ItemRow> =
        sqlx::query_as(concat!(item_select!(), " WHERE i.id = ? AND i.user_id = ?"))
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    row.map(ItemRow::into_item).transpose()
}

pub async fn create_item(pool: &MySqlPool, user_id: &str, new: NewItem) -> Result<Item> {
    // Link to the catalog when the barcode is already known (scanned/looked up).
    let product_id = product_id_for_barcode(pool, new.barcode.as_deref()).await?;
    let res = sqlx::query(
        "INSERT INTO items \
         (user_id, product_id, name, category, quantity, unit, expiry, location_id, barcode) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(product_id)
    .bind(&new.name)
    .bind(new.category.to_string())
    .bind(new.quantity)
    .bind(&new.unit)
    .bind(new.expiry)
    .bind(new.location_id)
    .bind(&new.barcode)
    .execute(pool)
    .await?;
    let id = res.last_insert_id();
    record_history(pool, id, user_id, new.location_id, "added", new.quantity).await?;
    get_item(pool, user_id, id)
        .await?
        .ok_or_else(|| anyhow!("created item {id} not found"))
}

/// Move an item to a new location (or `None` to detach). Returns the updated
/// item, or `None` if no such item belongs to this user.
pub async fn move_item(
    pool: &MySqlPool,
    user_id: &str,
    item_id: u64,
    new_location_id: Option<u64>,
) -> Result<Option<Item>> {
    if get_item(pool, user_id, item_id).await?.is_none() {
        return Ok(None);
    }
    sqlx::query("UPDATE items SET location_id = ? WHERE id = ? AND user_id = ?")
        .bind(new_location_id)
        .bind(item_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    record_history(pool, item_id, user_id, new_location_id, "moved", None).await?;
    get_item(pool, user_id, item_id).await
}

/// Update every field of an item. Returns the updated item, or `None` if no
/// such item belongs to the user. Records a `moved` history row if the location
/// changed.
pub async fn update_item(
    pool: &MySqlPool,
    user_id: &str,
    id: u64,
    new: NewItem,
) -> Result<Option<Item>> {
    let Some(existing) = get_item(pool, user_id, id).await? else {
        return Ok(None);
    };
    let product_id = product_id_for_barcode(pool, new.barcode.as_deref()).await?;
    sqlx::query(
        "UPDATE items SET product_id = ?, name = ?, category = ?, quantity = ?, unit = ?, \
         expiry = ?, location_id = ?, barcode = ? WHERE id = ? AND user_id = ?",
    )
    .bind(product_id)
    .bind(&new.name)
    .bind(new.category.to_string())
    .bind(new.quantity)
    .bind(&new.unit)
    .bind(new.expiry)
    .bind(new.location_id)
    .bind(&new.barcode)
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await?;
    if existing.location_id != new.location_id {
        record_history(pool, id, user_id, new.location_id, "moved", new.quantity).await?;
    }
    get_item(pool, user_id, id).await
}

/// Delete an item (its history cascades). Returns whether a row was removed.
pub async fn delete_item(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let res = sqlx::query("DELETE FROM items WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Delete a location. Child locations cascade; items there have their
/// `location_id` set NULL (per the FKs). Returns whether a row was removed.
pub async fn delete_location(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let res = sqlx::query("DELETE FROM locations WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

async fn record_history(
    pool: &MySqlPool,
    item_id: u64,
    user_id: &str,
    location_id: Option<u64>,
    event: &str,
    quantity: Option<f64>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO item_history (item_id, user_id, location_id, event, quantity) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(item_id)
    .bind(user_id)
    .bind(location_id)
    .bind(event)
    .bind(quantity)
    .execute(pool)
    .await?;
    Ok(())
}
