//! Router-level tests: drive `routes::router()` end-to-end via oneshot, no live
//! DB or socket. These cover the seams the repo/pure-fn tests can't reach — the
//! `AuthUser` 401 path, the `AppError`→status/JSON mapping, and the SPA/404
//! fallback. The pool is created lazily and never connects, because every path
//! here is rejected (401/404) before any query runs.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use life::config::Config;
use life::routes;
use life::state::AppState;
use sqlx::mysql::MySqlPoolOptions;
use tower::ServiceExt; // oneshot

fn test_state() -> AppState {
    // Lazy pool: constructing it does not connect (only used on paths we never
    // reach here). The URL just has to parse.
    let pool = MySqlPoolOptions::new()
        .connect_lazy("mysql://life:life@127.0.0.1:3307/life")
        .expect("lazy pool");
    let cfg = Config {
        database_url: "mysql://life:life@127.0.0.1:3307/life".into(),
        session_secret: "test-secret".into(),
        bind_addr: "127.0.0.1:0".into(),
        nc_base_url: "https://nc.example".into(),
        nc_client_id: "id".into(),
        nc_client_secret: "secret".into(),
        nc_redirect_uri: "https://life.example/auth/callback".into(),
        static_dir: None,
        dev_login_user: None,
        house_scene: "scenes/house.json".into(),
    };
    let http = reqwest::Client::new();
    AppState::new(pool, cfg, http)
}

async fn get(path: &str) -> (StatusCode, String) {
    send(Request::get(path).body(Body::empty()).unwrap()).await
}

async fn send(req: Request<Body>) -> (StatusCode, String) {
    let res = routes::router(test_state()).oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn healthz_is_open() {
    let (status, body) = get("/healthz").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "ok");
}

#[tokio::test]
async fn protected_api_requires_auth_and_maps_to_401_json() {
    // A representative sample of the authenticated surface — no cookie present.
    for path in [
        "/api/me",
        "/api/items",
        "/api/todo",
        "/api/trash",
        "/api/conflicts",
    ] {
        let (status, body) = get(path).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "GET {path}");
        // AppError::Unauthorized renders as a JSON error body, not empty/plain.
        assert!(
            body.contains("\"error\"") && body.contains("not authenticated"),
            "GET {path} body was {body:?}"
        );
    }
}

#[tokio::test]
async fn mutations_also_require_auth() {
    let req = axum::http::Request::post("/api/todo")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (status, _) = send(req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn dev_login_is_absent_without_dev_login_user() {
    // The route is only mounted when DEV_LOGIN_USER is set; here it isn't, so
    // it falls through to 404 (no static_dir either).
    let (status, _) = get("/dev-login").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unknown_path_is_404_when_api_only() {
    let (status, _) = get("/no/such/thing").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn conflict_restore_bad_kind_is_400_after_auth() {
    // Unauthenticated first — proves the ordering — then the point stands that
    // an unknown trash kind maps to 400 via BadRequest (exercised in the DB
    // test for the authed path). Here we assert the auth gate wins.
    let req = axum::http::Request::post("/api/trash/bogus/1/restore")
        .body(Body::empty())
        .unwrap();
    let (status, _) = send(req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
