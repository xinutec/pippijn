//! Nextcloud integration. Two boundaries only — identity (login) and, later,
//! calendar (CalDAV). life never writes to NC's database; see
//! docs/design/overview.md §2.

pub mod credentials;
pub mod identity;
pub mod login_flow;
