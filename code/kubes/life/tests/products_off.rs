//! The SSRF guard on the Open Food Facts image proxy, and the barcode guard on
//! the outbound lookup URL — exercised through the public API. Disallowed image
//! URLs and non-numeric barcodes short-circuit *before* any network call, so
//! these assertions are hermetic (no OFF request is ever made).

use life::products::off;

#[tokio::test]
async fn image_proxy_refuses_non_off_and_non_https_urls() {
    // A poisoned crowd-sourced image_url must be refused by the allowlist before
    // any fetch — otherwise it becomes an SSRF against internal services.
    for url in [
        "http://images.openfoodfacts.org/x.jpg",       // not https
        "https://evil.com/x.jpg",                      // foreign host
        "https://openfoodfacts.org.evil.com/x.jpg",    // look-alike suffix
        "https://images.openfoodfacts.org.evil.com/x", // look-alike subdomain
        "http://169.254.169.254/latest/meta-data/",    // link-local metadata
        "https://images.openfoodfacts.org@evil.com/x", // userinfo trick: real host is evil.com
        "file:///etc/passwd",                          // non-http scheme
        "not a url",
    ] {
        let got = off::fetch_image(url)
            .await
            .expect("the guard returns Ok(None), never an error");
        assert!(
            got.is_none(),
            "expected {url} to be refused, but it was fetched"
        );
    }
}

#[test]
fn upload_mime_accepts_only_raster_image_types() {
    // Accepted: the raster allowlist, with parameters and casing normalized away.
    assert_eq!(
        off::accept_upload_mime("image/jpeg").as_deref(),
        Some("image/jpeg")
    );
    assert_eq!(
        off::accept_upload_mime("image/png").as_deref(),
        Some("image/png")
    );
    assert_eq!(
        off::accept_upload_mime("image/webp").as_deref(),
        Some("image/webp")
    );
    assert_eq!(
        off::accept_upload_mime("image/avif").as_deref(),
        Some("image/avif")
    );
    assert_eq!(
        off::accept_upload_mime("IMAGE/JPEG; charset=binary").as_deref(),
        Some("image/jpeg"),
    );
    assert_eq!(
        off::accept_upload_mime("  image/gif ").as_deref(),
        Some("image/gif")
    );

    // Rejected: non-image types, and — crucially — SVG: it can carry script and
    // the stored bytes are served back on our own origin (stored XSS).
    for bad in [
        "",
        "application/octet-stream",
        "text/html",
        "image/",
        "image/svg+xml",
        "image/svg+xml; charset=utf-8",
        "imageX/png",
        "application/json",
    ] {
        assert!(
            off::accept_upload_mime(bad).is_none(),
            "expected {bad:?} to be rejected as an upload mime",
        );
    }
}

#[test]
fn sniff_identifies_raster_types_and_rejects_everything_else() {
    // Real magic-byte prefixes for each allowlisted type.
    assert_eq!(
        off::sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]),
        Some("image/jpeg")
    );
    assert_eq!(
        off::sniff_image_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]),
        Some("image/png")
    );
    assert_eq!(off::sniff_image_mime(b"GIF89a..."), Some("image/gif"));
    assert_eq!(off::sniff_image_mime(b"GIF87a..."), Some("image/gif"));
    assert_eq!(
        off::sniff_image_mime(b"RIFF\x10\x00\x00\x00WEBPVP8 "),
        Some("image/webp")
    );
    assert_eq!(
        off::sniff_image_mime(b"\x00\x00\x00\x20ftypavif...."),
        Some("image/avif")
    );
    assert_eq!(
        off::sniff_image_mime(b"\x00\x00\x00\x20ftypavis...."),
        Some("image/avif")
    );
    // Major brand mif1/msf1 with avif among the compatible brands (common).
    assert_eq!(
        off::sniff_image_mime(b"\x00\x00\x00\x1cftypmif1\x00\x00\x00\x00mif1avif"),
        Some("image/avif")
    );

    // Rejected: SVG (script-capable) and arbitrary bytes under any label —
    // the sniff is what's stored, so a lying Content-Type buys nothing.
    assert_eq!(
        off::sniff_image_mime(b"<svg xmlns='http://www.w3.org/2000/svg'>"),
        None
    );
    assert_eq!(
        off::sniff_image_mime(b"<!doctype html><script>alert(1)</script>"),
        None
    );
    assert_eq!(off::sniff_image_mime(b""), None);
    assert_eq!(off::sniff_image_mime(b"RIFF\x10\x00\x00\x00WAVE"), None); // RIFF but not WebP
    assert_eq!(off::sniff_image_mime(b"\x00\x00\x00\x20ftypmp42...."), None); // BMFF but not AVIF
}

#[test]
fn upload_barcode_guard_matches_lookup() {
    // The upload handler reuses the lookup barcode guard: numeric, 1..=14 digits.
    assert!(off::is_valid_barcode("5000112548167"));
    for bad in ["", "abc", "12345678901234567", "12/34", "../x"] {
        assert!(
            !off::is_valid_barcode(bad),
            "expected {bad:?} to be rejected"
        );
    }
}

#[tokio::test]
async fn lookup_ignores_non_numeric_barcodes() {
    // A non-numeric/oversized barcode must not be spliced into the OFF URL: the
    // guard returns Ok(None) before building any request (so the client here is
    // never actually used).
    let client = reqwest::Client::new();
    for barcode in [
        "",
        "abc",
        "123?fields=all",
        "../../secret",
        "123456789012345",
    ] {
        let got = off::fetch(&client, barcode)
            .await
            .expect("the guard returns Ok(None), never an error");
        assert!(got.is_none(), "expected barcode {barcode:?} to be ignored");
    }
}
