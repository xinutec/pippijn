//! Router-level tests that need no database: they drive the app via
//! `oneshot` and exercise paths that return before touching the pool (healthz,
//! auth rejection, schema rejection). The pool is created lazily so no DB
//! connection is made — these run in a plain `cargo test`.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use vantage::config::Config;
use vantage::routes;
use vantage::state::AppState;
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
    };
    routes::router(AppState::new(pool, cfg))
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
