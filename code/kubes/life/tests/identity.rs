//! NC OAuth2 authorize-URL construction — the browser-facing redirect.

use life::config::Config;
use life::nextcloud::identity::authorize_url;

fn cfg() -> Config {
    Config {
        database_url: String::new(),
        session_secret: String::new(),
        bind_addr: String::new(),
        nc_base_url: "https://nc.example.org".into(),
        nc_client_id: "cid".into(),
        nc_client_secret: "secret".into(),
        nc_redirect_uri: "https://life.example.org/auth/callback".into(),
        static_dir: None,
        dev_login_user: None,
        house_scene: "scenes/house.json".into(),
    }
}

#[test]
fn authorize_url_has_expected_params() {
    let url = url::Url::parse(&authorize_url(&cfg(), "st8")).unwrap();
    assert_eq!(url.path(), "/index.php/apps/oauth2/authorize");
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q.get("client_id").map(String::as_str), Some("cid"));
    assert_eq!(q.get("response_type").map(String::as_str), Some("code"));
    assert_eq!(q.get("state").map(String::as_str), Some("st8"));
    assert_eq!(
        q.get("redirect_uri").map(String::as_str),
        Some("https://life.example.org/auth/callback")
    );
    // The client secret must never appear in the browser-facing URL.
    assert!(!url.as_str().contains("secret"));
}
