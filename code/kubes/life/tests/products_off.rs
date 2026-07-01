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
fn upload_mime_accepts_only_image_types() {
    // Accepted: any image/* subtype, with parameters and casing normalized away.
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
        off::accept_upload_mime("IMAGE/JPEG; charset=binary").as_deref(),
        Some("image/jpeg"),
    );
    assert_eq!(
        off::accept_upload_mime("  image/gif ").as_deref(),
        Some("image/gif")
    );

    // Rejected: non-image types, the bare prefix with no subtype, and empties.
    for bad in [
        "",
        "application/octet-stream",
        "text/html",
        "image/",
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
