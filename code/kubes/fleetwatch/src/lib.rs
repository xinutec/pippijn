//! fleetwatch backend library — the fleet monitoring platform's ingest + query API.
//!
//! fleetwatch knows nothing about *what* is being checked: producers (the Mac mini
//! tools first) POST verdict-shaped reports, fleetwatch stores their history and
//! serves them to the mobile UI. Adding a producer needs zero code here.
//!
//! The binary (`src/main.rs`) is a thin wrapper; tests live in `tests/` and
//! exercise this public surface.

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod nextcloud;
pub mod report;
pub mod routes;
pub mod session;
pub mod state;
