//! vantage backend library — the fleet monitoring platform's ingest + query API.
//!
//! vantage knows nothing about *what* is being checked: producers (the Mac mini
//! tools first) POST verdict-shaped reports, vantage stores their history and
//! serves them to the mobile UI. Adding a producer needs zero code here.
//!
//! The binary (`src/main.rs`) is a thin wrapper; tests live in `tests/` and
//! exercise this public surface.

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod report;
pub mod routes;
pub mod state;
