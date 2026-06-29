//! Product reference data (cached from Open Food Facts).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Product {
    pub barcode: String,
    pub name: Option<String>,
    pub brand: Option<String>,
    pub quantity_label: Option<String>,
    /// True if we have a cached image (served from /api/products/{barcode}/image).
    pub has_image: bool,
}
