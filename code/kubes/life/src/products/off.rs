//! Open Food Facts client — read-only product lookup by barcode. We call OFF
//! only on a cache miss (see products::repo). Identify our client politely.

use anyhow::{Context, Result};
use serde::Deserialize;

const USER_AGENT: &str = "Life/0.1 (https://life.xinutec.org)";

/// Product images are small; cap the download so a poisoned URL can't OOM the
/// pod (256Mi) by streaming gigabytes.
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

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

/// Barcodes are numeric (EAN/UPC), at most 14 digits. Validate before we splice
/// the value into the outbound OFF URL, so it can't add path segments or query
/// params. (DB lookups are parameterized; this is purely about the outbound URL.)
pub fn is_valid_barcode(barcode: &str) -> bool {
    !barcode.is_empty() && barcode.len() <= 14 && barcode.bytes().all(|b| b.is_ascii_digit())
}

/// Same size cap as the OFF proxy, reused for user uploads. Public so the upload
/// handler and its tests share one number.
pub const MAX_UPLOAD_BYTES: usize = MAX_IMAGE_BYTES;

/// Raster types we store and serve. Deliberately NOT `image/svg+xml`: SVG can
/// carry script, and stored images are served back on our own origin — an SVG
/// upload would be stored XSS for anyone opening the image URL directly.
const ALLOWED_IMAGE_MIMES: [&str; 5] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
];

/// Validate an image `Content-Type` against the raster allowlist. Returns the
/// normalized mime (parameters like `; charset=…` stripped, lowercased). Applied
/// to user uploads and to images fetched from OFF alike, so hand-uploaded and
/// crowd-sourced images share one rule.
pub fn accept_upload_mime(content_type: &str) -> Option<String> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ALLOWED_IMAGE_MIMES.contains(&mime.as_str()).then_some(mime)
}

/// Identify the actual image type from its magic bytes — the declared
/// Content-Type is caller-supplied and can lie. The sniffed type (a member of
/// the raster allowlist by construction) is what gets STORED and served back,
/// so mislabelled bytes can't ride in under an innocent-looking mime. `None` =
/// not one of ours; reject.
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => return Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => return Some("image/png"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => return Some("image/gif"),
        // RIFF container: "RIFF" <size> "WEBP".
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => {
            return Some("image/webp");
        }
        _ => {}
    }
    // ISO-BMFF (AVIF): "<size>ftyp<major-brand><compatible-brands…>". Real-world
    // encoders often set the major brand to `mif1`/`msf1` and list `avif` only
    // among the compatible brands, so scan the ftyp box for the `avif`/`avis`
    // tag rather than matching the major brand alone. HEIC lists heic/heix (not
    // avif), so this won't misclassify it.
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let end = bytes.len().min(64);
        if bytes[8..end]
            .windows(4)
            .any(|w| w == b"avif" || w == b"avis")
        {
            return Some("image/avif");
        }
    }
    None
}

/// Look up a barcode. `Ok(None)` = OFF has no such product.
pub async fn fetch(http: &reqwest::Client, barcode: &str) -> Result<Option<OffProduct>> {
    if !is_valid_barcode(barcode) {
        return Ok(None);
    }
    let url = format!(
        "https://world.openfoodfacts.org/api/v2/product/{barcode}.json\
         ?fields=product_name,brands,quantity,image_front_url"
    );
    let res = http
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let env: Envelope = res.json().await.context("parsing OFF response")?;
    if env.status != 1 {
        return Ok(None);
    }
    let Some(p) = env.product else {
        return Ok(None);
    };
    Ok(Some(OffProduct {
        name: non_empty(p.product_name),
        brand: non_empty(p.brands),
        quantity: non_empty(p.quantity),
        image_url: non_empty(p.image_front_url),
    }))
}

/// Only fetch product images that are https and on the openfoodfacts.org domain.
/// OFF data is crowd-sourced, so a poisoned `image_url` must not be able to point
/// us at an internal service — this is the SSRF guard. The leading-dot suffix
/// check rejects look-alikes like `openfoodfacts.org.evil.com`.
fn is_allowed_image_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    match parsed.host_str() {
        Some(host) => host == "openfoodfacts.org" || host.ends_with(".openfoodfacts.org"),
        None => false,
    }
}

/// Download a product image — https + openfoodfacts.org only, no redirects,
/// bounded time and size, and the response must actually be an image. `Ok(None)`
/// if the URL is disallowed or the image can't be fetched (the caller then just
/// caches no image and the UI falls back to an icon).
pub async fn fetch_image(url: &str) -> Result<Option<(Vec<u8>, String)>> {
    if !is_allowed_image_url(url) {
        tracing::warn!(%url, "refusing product image: not an https openfoodfacts.org URL");
        return Ok(None);
    }
    // A dedicated no-redirect client: even an allowlisted URL must not be able to
    // bounce us (via 3xx) to an internal host. Timeout bounds a hung server.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let mut res = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let declared = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg");
    let Some(mime) = accept_upload_mime(declared) else {
        tracing::warn!(%url, %declared, "refusing product image: not an allowed image type");
        return Ok(None);
    };
    if res
        .content_length()
        .is_some_and(|n| n > MAX_IMAGE_BYTES as u64)
    {
        tracing::warn!(%url, "refusing product image: declared size over cap");
        return Ok(None);
    }
    // Stream with a hard cap, in case Content-Length is absent or lying.
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await? {
        if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
            tracing::warn!(%url, "refusing product image: streamed size over cap");
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    // The bytes, not the header, decide what we store: sniff the magic bytes
    // and refuse anything that isn't genuinely one of our raster types.
    let Some(sniffed) = sniff_image_mime(&bytes) else {
        tracing::warn!(%url, %mime, "refusing product image: bytes are not a known raster type");
        return Ok(None);
    };
    Ok(Some((bytes, sniffed.to_string())))
}
