//! Shopping-list types. A shopping item is a "to buy" line; quantity/unit are
//! optional. `done` = ticked off as bought.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShoppingItem {
    pub id: u64,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub barcode: Option<String>,
    pub done: bool,
}

/// Request body for adding something to buy.
#[derive(Debug, Deserialize)]
pub struct NewShoppingItem {
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    #[serde(default)]
    pub barcode: Option<String>,
}

/// Full update (used for edits and the done toggle).
#[derive(Debug, Deserialize)]
pub struct UpdateShoppingItem {
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    #[serde(default)]
    pub barcode: Option<String>,
    pub done: bool,
}
