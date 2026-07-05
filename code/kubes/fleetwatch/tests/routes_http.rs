//! Router-level tests that need no database: they drive the app via
//! `oneshot` and exercise paths that return before touching the pool (healthz,
//! auth rejection, schema rejection). The pool is created lazily so no DB
//! connection is made — these run in a plain `cargo test`.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use fleetwatch::config::Config;
use fleetwatch::routes;
use fleetwatch::state::AppState;
use tower::ServiceExt;

fn app() -> axum::Router {
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        // connect_lazy never dials until a query runs; the tests below never
        // reach a query, so no MariaDB is required.
        .connect_lazy("mysql://unused:unused@127.0.0.1:1/unused")
        .expect("lazy pool");
    let cfg = Config {
        database_url: "unused".into(),
        bind_addr: "0.0.0.0:0".into(),
        static_dir: None,
        tokens: vec![("mac-mini".into(), "secret-token".into())],
        raw_retention_days: 30,
        check_retention_days: 400,
        session_secret: "test-session-secret".into(),
        nc_base_url: "https://nc.example".into(),
        nc_client_id: "test-client".into(),
        nc_client_secret: "test-secret".into(),
        nc_redirect_uri: "https://fleetwatch.example/auth/callback".into(),
        dev_login_user: None,
    };
    routes::router(AppState::new(pool, cfg, reqwest::Client::new()))
}

#[tokio::test]
async fn healthz_ok() {
    let res = app()
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn ingest_without_token_is_401() {
    let res = app()
        .oneshot(
            Request::post("/api/reports")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"schema":1}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn ingest_with_wrong_token_is_401() {
    let res = app()
        .oneshot(
            Request::post("/api/reports")
                .header("authorization", "Bearer wrong")
                .body(Body::from(r#"{"schema":1}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn read_endpoint_without_session_is_401() {
    // The human read side is gated by the NC-login session (AuthUser). The
    // extractor rejects before touching the pool, so no DB is needed here.
    let res = app()
        .oneshot(Request::get("/api/overview").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn authed_but_unparseable_body_is_422() {
    let res = app()
        .oneshot(
            Request::post("/api/reports")
                .header("authorization", "Bearer secret-token")
                .body(Body::from("not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
}
