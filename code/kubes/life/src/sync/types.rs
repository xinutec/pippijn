//! Wire types for the offline-first sync protocol (RxDB-compatible).
//!
//! A *document* is the canonical synced shape of a row, keyed by its `ulid` and
//! carrying the server `rev` (version) plus RxDB's `_deleted` tombstone flag. The
//! checkpoint is simply the highest `rev` the client has pulled.
//! See `docs/proposals/offline-first.md`.

use serde::{Deserialize, Serialize};

/// One shopping row as it travels over sync. `rev` is the server revision; a pull
/// returns rows ordered by it and the client checkpoints on the maximum seen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShoppingDoc {
    pub ulid: String,
    /// Server autoincrement id — carried on *pull* so the client can still call the
    /// legacy `/api/shopping/{id}/buy` (convert→inventory) for already-synced rows.
    /// Ignored on push (offline-created rows have none until they sync).
    #[serde(default)]
    pub id: Option<u64>,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub barcode: Option<String>,
    pub done: bool,
    /// RxDB tombstone flag (maps to `deleted_at IS NOT NULL`).
    #[serde(rename = "_deleted", default)]
    pub deleted: bool,
    /// Server revision (version). Ignored as push *input*; set by the server.
    #[serde(default)]
    pub rev: u64,
}

/// A page of pulled documents plus the advanced checkpoint.
#[derive(Debug, Serialize)]
pub struct PullResponse {
    pub documents: Vec<ShoppingDoc>,
    pub checkpoint: Checkpoint,
}

/// The opaque (to the client) pull cursor: the highest `rev` delivered so far.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Checkpoint {
    pub rev: u64,
}

/// One change pushed by the client: the desired new state, plus the master state
/// the client assumed (null for a fresh insert) — used for optimistic-concurrency
/// conflict detection.
#[derive(Debug, Deserialize)]
pub struct PushEntry {
    #[serde(rename = "newDocumentState")]
    pub new_document_state: ShoppingDoc,
    #[serde(rename = "assumedMasterState", default)]
    pub assumed_master_state: Option<ShoppingDoc>,
}
