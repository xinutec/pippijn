//! HTTP routing table.

pub mod api;
pub mod auth;
pub mod exercises;
pub mod pacing;
pub mod program;
pub mod settings;
pub mod workout;

use axum::Router;
use axum::routing::{delete, get, patch, post};

use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/me", get(api::me))
        // Exercise catalog
        .route("/exercises", get(exercises::list).post(exercises::create))
        .route("/exercises/{id}", patch(exercises::patch))
        // Programs
        .route("/programs", get(program::list))
        .route("/programs/active", get(program::active))
        .route("/programs/starter", post(program::create_starter))
        .route("/programs/{id}", get(program::detail))
        .route("/programs/{id}/activate", post(program::activate))
        .route("/programs/{id}/pins", post(program::upsert_pin))
        .route("/programs/{id}/pins/{pinId}", delete(program::delete_pin))
        .route("/program-targets/{id}", patch(program::patch_target))
        // Micro-log
        .route("/sets", get(workout::list).post(workout::create))
        .route("/sets/{id}", delete(workout::delete))
        // Pacing settings + the live pacing verdict
        .route("/settings", get(settings::get).patch(settings::patch))
        .route("/pacing/now", get(pacing::now))
        // One INFO line per API request (method, path, status, latency). Scoped to
        // /api so static-asset serving and the k8s /healthz probe don't spam it.
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        );

    let mut app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .route("/logout", post(auth::logout))
        .nest("/api", api);

    // DEV ONLY: mount /dev-login only when DEV_LOGIN_USER is set.
    if state.cfg.dev_login_user.is_some() {
        app = app.route("/dev-login", get(auth::dev_login));
    }

    // Serve the built Angular bundle (single origin), falling back to
    // index.html so client-side routes resolve. API-only when STATIC_DIR unset.
    if let Some(dir) = state.cfg.static_dir.clone() {
        let serve = ServeDir::new(&dir).fallback(ServeFile::new(format!("{dir}/index.html")));
        app = app.fallback_service(serve);
    }

    app.with_state(state)
}
