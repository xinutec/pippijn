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
