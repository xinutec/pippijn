//! The pacing engine and its HTTP surface. `engine::evaluate` is a pure
//! function (unit-tested); `service::now` assembles its input from the DB and
//! applies the user's timezone.

pub mod engine;
pub mod service;
pub mod types;
