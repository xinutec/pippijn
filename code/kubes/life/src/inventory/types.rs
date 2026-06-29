//! Domain types for the location/item model. `kind` and `category` are stored
//! as short strings in the DB and parsed into these enums at the repo boundary.

use std::fmt;
use std::str::FromStr;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// A node kind in the spatial tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocationKind {
    House,
    Room,
    Cupboard,
    Fridge,
    Layer,
}

impl fmt::Display for LocationKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            LocationKind::House => "house",
            LocationKind::Room => "room",
            LocationKind::Cupboard => "cupboard",
            LocationKind::Fridge => "fridge",
            LocationKind::Layer => "layer",
        };
        f.write_str(s)
    }
}

impl FromStr for LocationKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "house" => Ok(LocationKind::House),
            "room" => Ok(LocationKind::Room),
            "cupboard" => Ok(LocationKind::Cupboard),
            "fridge" => Ok(LocationKind::Fridge),
            "layer" => Ok(LocationKind::Layer),
            other => Err(format!("unknown location kind {other:?}")),
        }
    }
}

/// Item category. Generic from day one — food is just the first skin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemCategory {
    Food,
    Medication,
    Tool,
    Document,
    Other,
}

impl fmt::Display for ItemCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ItemCategory::Food => "food",
            ItemCategory::Medication => "medication",
            ItemCategory::Tool => "tool",
            ItemCategory::Document => "document",
            ItemCategory::Other => "other",
        };
        f.write_str(s)
    }
}

impl FromStr for ItemCategory {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "food" => Ok(ItemCategory::Food),
            "medication" => Ok(ItemCategory::Medication),
            "tool" => Ok(ItemCategory::Tool),
            "document" => Ok(ItemCategory::Document),
            "other" => Ok(ItemCategory::Other),
            other => Err(format!("unknown item category {other:?}")),
        }
    }
}

/// A spatial node as returned by the API.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Location {
    pub id: u64,
    pub kind: LocationKind,
    pub name: String,
    pub parent_id: Option<u64>,
    pub sort_order: i32,
    pub position: Option<serde_json::Value>,
}

/// A tracked item (holding) as returned by the API. `name`/`brand`/`barcode`/
/// `has_image` are *resolved*: they come from the linked catalog product when
/// `product_id` is set, falling back to the item's own fields otherwise.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Item {
    pub id: u64,
    pub product_id: Option<u64>,
    pub name: String,
    pub brand: Option<String>,
    pub category: ItemCategory,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub expiry: Option<NaiveDate>,
    pub location_id: Option<u64>,
    pub barcode: Option<String>,
    /// True when the linked product has a cached image
    /// (served from /api/products/{barcode}/image).
    pub has_image: bool,
}

/// Request body for creating a location.
#[derive(Debug, Deserialize)]
pub struct NewLocation {
    pub kind: LocationKind,
    pub name: String,
    pub parent_id: Option<u64>,
    #[serde(default)]
    pub sort_order: i32,
    pub position: Option<serde_json::Value>,
}

/// Request body for creating an item.
#[derive(Debug, Deserialize)]
pub struct NewItem {
    pub name: String,
    #[serde(default = "default_category")]
    pub category: ItemCategory,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub expiry: Option<NaiveDate>,
    pub location_id: Option<u64>,
    #[serde(default)]
    pub barcode: Option<String>,
}

fn default_category() -> ItemCategory {
    ItemCategory::Other
}
