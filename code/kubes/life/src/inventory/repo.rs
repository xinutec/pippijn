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
         WHERE user_id = ? AND deleted_at IS NULL ORDER BY parent_id, sort_order, id",
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
    let rows: Vec<ItemRow> = sqlx::query_as(concat!(
        item_select!(),
        " WHERE i.user_id = ? AND i.deleted_at IS NULL ORDER BY name"
    ))
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(ItemRow::into_item).collect()
}

pub async fn get_item(pool: &MySqlPool, user_id: &str, id: u64) -> Result<Option<Item>> {
    let row: Option<ItemRow> = sqlx::query_as(concat!(
        item_select!(),
        " WHERE i.id = ? AND i.user_id = ? AND i.deleted_at IS NULL"
    ))
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

/// Delete an item — a tombstone, restorable from the trash; history is kept.
/// Returns whether a row was tombstoned.
pub async fn delete_item(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE items SET deleted_at = NOW() \
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await?;
    let deleted = res.rows_affected() > 0;
    if deleted {
        record_history(pool, id, user_id, None, "removed", None).await?;
    }
    Ok(deleted)
}

/// Restore a deleted item. Returns whether a tombstone was cleared.
pub async fn restore_item(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE items SET deleted_at = NULL \
         WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await?;
    let restored = res.rows_affected() > 0;
    if restored {
        record_history(pool, id, user_id, None, "restored", None).await?;
    }
    Ok(restored)
}

/// Every location id in the subtree rooted at `root` (inclusive), computed from
/// ALL of the user's rows (deleted or not — parent links stay intact under
/// tombstoning). Empty if `root` isn't the user's.
async fn subtree_ids(pool: &MySqlPool, user_id: &str, root: u64) -> Result<Vec<u64>> {
    let rows: Vec<(u64, Option<u64>)> =
        sqlx::query_as("SELECT id, parent_id FROM locations WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    if !rows.iter().any(|(id, _)| *id == root) {
        return Ok(Vec::new());
    }
    let mut children: std::collections::HashMap<u64, Vec<u64>> = std::collections::HashMap::new();
    for (id, parent) in &rows {
        if let Some(p) = parent {
            children.entry(*p).or_default().push(*id);
        }
    }
    let mut ids = vec![root];
    let mut i = 0;
    while i < ids.len() {
        if let Some(kids) = children.get(&ids[i]) {
            ids.extend(kids);
        }
        i += 1;
    }
    Ok(ids)
}

/// Delete a location and its whole subtree — tombstones, restorable as one unit
/// (every row gets the SAME `deleted_at` stamp; restore keys on it). Items keep
/// their `location_id`: with the location hidden they read as unplaced, and a
/// restore puts them right back where they were. Returns whether the root was
/// tombstoned.
pub async fn delete_location(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let ids = subtree_ids(pool, user_id, id).await?;
    if ids.is_empty() {
        return Ok(false);
    }
    let mut qb =
        sqlx::QueryBuilder::new("UPDATE locations SET deleted_at = NOW() WHERE user_id = ");
    qb.push_bind(user_id);
    qb.push(" AND deleted_at IS NULL AND id IN (");
    let mut sep = qb.separated(", ");
    for i in &ids {
        sep.push_bind(i);
    }
    qb.push(")");
    let res = qb.build().execute(pool).await?;
    Ok(res.rows_affected() > 0)
}

/// Restore a deleted location together with the descendants that were deleted
/// in the same operation (same `deleted_at` stamp — descendants deleted
/// separately earlier stay in the trash as their own entries). Returns whether
/// anything was restored.
pub async fn restore_location(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let stamp: Option<(Option<chrono::NaiveDateTime>,)> =
        sqlx::query_as("SELECT deleted_at FROM locations WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    let Some((Some(stamp),)) = stamp else {
        return Ok(false); // unknown, someone else's, or not deleted
    };
    let ids = subtree_ids(pool, user_id, id).await?;
    let mut qb = sqlx::QueryBuilder::new("UPDATE locations SET deleted_at = NULL WHERE user_id = ");
    qb.push_bind(user_id);
    qb.push(" AND deleted_at = ");
    qb.push_bind(stamp);
    qb.push(" AND id IN (");
    let mut sep = qb.separated(", ");
    for i in &ids {
        sep.push_bind(i);
    }
    qb.push(")");
    let res = qb.build().execute(pool).await?;
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
