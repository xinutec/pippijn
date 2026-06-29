//! Product reference data (cached from Open Food Facts).

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Product {
    /// Catalog id (surrogate key). A product may have no barcode (hand-defined).
    #[ts(type = "number")]
    pub id: u64,
    pub barcode: Option<String>,
    pub name: Option<String>,
    pub brand: Option<String>,
    pub quantity_label: Option<String>,
    /// True if we have a cached image (served from /api/products/{barcode}/image).
    pub has_image: bool,
}
