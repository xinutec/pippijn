//! life backend library. The binary (`src/main.rs`) is a thin wrapper; tests
//! live in `tests/` and exercise this public surface.

pub mod config;
pub mod db;
pub mod error;
pub mod inventory;
pub mod nextcloud;
pub mod products;
pub mod recipes;
pub mod routes;
pub mod session;
pub mod shopping;
pub mod state;
pub mod sync;
