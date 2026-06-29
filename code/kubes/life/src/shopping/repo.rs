//! Persistence for the shopping list.

use anyhow::Result;
use sqlx::MySqlPool;

use super::types::{NewShoppingItem, ShoppingItem, UpdateShoppingItem};

#[derive(sqlx::FromRow)]
struct Row {
    id: u64,
    name: String,
    quantity: Option<f64>,
    unit: Option<String>,
    done: bool,
}

impl From<Row> for ShoppingItem {
    fn from(r: Row) -> Self {
        ShoppingItem {
            id: r.id,
            name: r.name,
            quantity: r.quantity,
            unit: r.unit,
            done: r.done,
        }
    }
}

/// To-buy items, undone first, then by name.
pub async fn list(pool: &MySqlPool, user_id: &str) -> Result<Vec<ShoppingItem>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, name, quantity, unit, done FROM shopping_items \
         WHERE user_id = ? ORDER BY done, name",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn get(pool: &MySqlPool, user_id: &str, id: u64) -> Result<Option<ShoppingItem>> {
    let row: Option<Row> =
        sqlx::query_as("SELECT id, name, quantity, unit, done FROM shopping_items WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(Into::into))
}

pub async fn create(pool: &MySqlPool, user_id: &str, new: NewShoppingItem) -> Result<ShoppingItem> {
    let res = sqlx::query("INSERT INTO shopping_items (user_id, name, quantity, unit) VALUES (?, ?, ?, ?)")
        .bind(user_id)
        .bind(&new.name)
        .bind(new.quantity)
        .bind(&new.unit)
        .execute(pool)
        .await?;
    Ok(ShoppingItem {
        id: res.last_insert_id(),
        name: new.name,
        quantity: new.quantity,
        unit: new.unit,
        done: false,
    })
}

pub async fn update(
    pool: &MySqlPool,
    user_id: &str,
    id: u64,
    upd: UpdateShoppingItem,
) -> Result<Option<ShoppingItem>> {
    if get(pool, user_id, id).await?.is_none() {
        return Ok(None);
    }
    sqlx::query(
        "UPDATE shopping_items SET name = ?, quantity = ?, unit = ?, done = ? \
         WHERE id = ? AND user_id = ?",
    )
    .bind(&upd.name)
    .bind(upd.quantity)
    .bind(&upd.unit)
    .bind(upd.done)
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await?;
    get(pool, user_id, id).await
}

pub async fn delete(pool: &MySqlPool, user_id: &str, id: u64) -> Result<bool> {
    let res = sqlx::query("DELETE FROM shopping_items WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}
