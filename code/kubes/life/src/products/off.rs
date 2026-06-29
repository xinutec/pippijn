//! Open Food Facts client — read-only product lookup by barcode. We call OFF
//! only on a cache miss (see products::repo). Identify our client politely.

use anyhow::{Context, Result};
use serde::Deserialize;

const USER_AGENT: &str = "Life/0.1 (https://life.xinutec.org)";

pub struct OffProduct {
    pub name: Option<String>,
    pub brand: Option<String>,
    pub quantity: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Deserialize)]
struct Envelope {
    status: i64,
    product: Option<Raw>,
}

#[derive(Deserialize)]
struct Raw {
    product_name: Option<String>,
    brands: Option<String>,
    quantity: Option<String>,
    image_front_url: Option<String>,
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

/// Look up a barcode. `Ok(None)` = OFF has no such product.
pub async fn fetch(http: &reqwest::Client, barcode: &str) -> Result<Option<OffProduct>> {
    let url = format!(
        "https://world.openfoodfacts.org/api/v2/product/{barcode}.json\
         ?fields=product_name,brands,quantity,image_front_url"
    );
    let res = http.get(&url).header("User-Agent", USER_AGENT).send().await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let env: Envelope = res.json().await.context("parsing OFF response")?;
    if env.status != 1 {
        return Ok(None);
    }
    let Some(p) = env.product else { return Ok(None) };
    Ok(Some(OffProduct {
        name: non_empty(p.product_name),
        brand: non_empty(p.brands),
        quantity: non_empty(p.quantity),
        image_url: non_empty(p.image_front_url),
    }))
}

/// Download an image; returns (bytes, mime). `Ok(None)` if it can't be fetched.
pub async fn fetch_image(http: &reqwest::Client, url: &str) -> Result<Option<(Vec<u8>, String)>> {
    let res = http.get(url).header("User-Agent", USER_AGENT).send().await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = res.bytes().await?.to_vec();
    Ok(Some((bytes, mime)))
}
