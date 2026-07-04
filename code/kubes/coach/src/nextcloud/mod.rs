//! Nextcloud integration. One boundary only — identity (login). coach never
//! writes to NC and stores no NC tokens; the access token is used once at
//! login to read `{id, displayname}` and discarded.

pub mod identity;
