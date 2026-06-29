//! HTTP routing table.

pub mod api;
pub mod auth;
pub mod inventory;
pub mod products;
pub mod recipes;
pub mod shopping;

use axum::Router;
use axum::routing::{delete, get, patch, post};
use tower_http::services::{ServeDir, ServeFile};

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
        .route("/search", get(inventory::search))
        .route("/recipes", get(recipes::list).post(recipes::create))
        .route(
            "/recipes/{id}",
            get(recipes::get_one).delete(recipes::delete),
        )
        .route("/recipes/{id}/shopping-list", get(recipes::shopping_list))
        .route("/cookable", get(recipes::cookable))
        .route(
            "/shopping",
            get(shopping::list).post(shopping::create),
        )
        .route(
            "/shopping/{id}",
            patch(shopping::update).delete(shopping::delete),
        )
        .route("/shopping/{id}/buy", post(shopping::buy))
        .route("/products/{barcode}", get(products::lookup))
        .route("/products/{barcode}/image", get(products::image));

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
