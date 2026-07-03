//! HTTP routing table.

pub mod api;
pub mod auth;
pub mod conflicts;
pub mod inventory;
pub mod products;
pub mod recipes;
pub mod shopping;
pub mod sync;
pub mod todo;
pub mod trash;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, patch, post};

use crate::products::off;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/me", get(api::me))
        .route("/house", get(api::house))
        .route("/nextcloud/connect/init", post(auth::connect_init))
        .route("/nextcloud/connect/status", get(auth::connect_status))
        .route(
            "/locations",
            get(inventory::list_locations).post(inventory::create_location),
        )
        .route("/locations/{id}", delete(inventory::delete_location))
        .route(
            "/items",
            get(inventory::list_items).post(inventory::create_item),
        )
        .route(
            "/items/{id}",
            patch(inventory::update_item).delete(inventory::delete_item),
        )
        .route("/items/{id}/move", post(inventory::move_item))
        .route("/recipes", get(recipes::list).post(recipes::create))
        .route(
            "/recipes/{id}",
            get(recipes::get_one).delete(recipes::delete),
        )
        .route("/recipes/{id}/shopping-list", get(recipes::shopping_list))
        .route("/cookable", get(recipes::cookable))
        .route("/shopping", get(shopping::list).post(shopping::create))
        .route(
            "/shopping/{id}",
            patch(shopping::update).delete(shopping::delete),
        )
        .route("/shopping/{id}/buy", post(shopping::buy))
        .route(
            "/sync/shopping",
            get(sync::pull_shopping).post(sync::push_shopping),
        )
        .route("/todo", get(todo::list).post(todo::create))
        .route("/todo/{id}", patch(todo::update).delete(todo::delete))
        .route("/sync/todo", get(sync::pull_todo).post(sync::push_todo))
        .route("/todo-links", get(todo::list_links).post(todo::create_link))
        .route("/todo-links/{id}", delete(todo::delete_link))
        .route(
            "/sync/todo-link",
            get(sync::pull_todo_link).post(sync::push_todo_link),
        )
        .route(
            "/sync/wellbeing",
            get(sync::pull_wellbeing).post(sync::push_wellbeing),
        )
        .route("/conflicts", get(conflicts::list).post(conflicts::create))
        .route("/conflicts/{id}/resolve", post(conflicts::resolve))
        .route("/trash", get(trash::list))
        .route("/trash/{kind}/{ref}/restore", post(trash::restore))
        .route("/products/{barcode}", get(products::lookup))
        .route(
            "/products/{barcode}/image",
            // Image uploads can be a few MiB; raise the default 2 MiB body limit
            // for THIS route only (the handler re-checks the real 5 MiB cap). The
            // GET side has no request body, so the raised limit is harmless there.
            get(products::image)
                .put(products::set_image)
                .layer(DefaultBodyLimit::max(off::MAX_UPLOAD_BYTES + 64 * 1024)),
        )
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
