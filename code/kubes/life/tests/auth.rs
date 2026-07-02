//! Post-login redirect allowlist — must not become an open redirect.

use life::routes::auth::validate_return_to;

#[test]
fn allows_internal_paths() {
    assert_eq!(validate_return_to(Some("/recipes")), "/recipes");
    assert_eq!(validate_return_to(Some("/items?id=4")), "/items?id=4");
}

#[test]
fn rejects_open_redirects_and_falls_back_to_root() {
    assert_eq!(validate_return_to(Some("//evil.example")), "/");
    // Browsers fold `\` to `/` in URLs, so `/\evil` is `//evil` in disguise.
    assert_eq!(validate_return_to(Some("/\\evil.example")), "/");
    assert_eq!(validate_return_to(Some("https://evil.example")), "/");
    assert_eq!(validate_return_to(Some("evil")), "/");
    assert_eq!(validate_return_to(None), "/");
}
