//! Wire types for the offline-first sync protocol (RxDB-compatible).
//!
//! A *document* is the canonical synced shape of a row, keyed by its `ulid` and
//! carrying the server `rev` (version) plus RxDB's `_deleted` tombstone flag. The
//! checkpoint is simply the highest `rev` the client has pulled. The page/entry
//! envelopes are generic over the document type so each collection reuses them.
//! See `docs/proposals/offline-first.md`.

use chrono::{DateTime, NaiveDate, Utc};
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

/// One to-do row as it travels over sync. The type/status enums ride as their
/// snake_case strings (the raw row shape), parsed to enums only at the typed API
/// boundary — exactly as the DB stores them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoDoc {
    pub ulid: String,
    #[serde(default)]
    pub id: Option<u64>,
    pub title: String,
    #[serde(rename = "type")]
    pub todo_type: String,
    pub status: String,
    #[serde(default)]
    pub priority: Option<String>,
    pub notes: Option<String>,
    #[serde(rename = "notBefore", default)]
    pub not_before: Option<NaiveDate>,
    #[serde(default)]
    pub due: Option<NaiveDate>,
    #[serde(rename = "_deleted", default)]
    pub deleted: bool,
    #[serde(default)]
    pub rev: u64,
}

/// One wellbeing check-in as it travels over sync. `recorded_at` is the moment
/// the feeling was (UTC, RFC3339 on the wire); `score` is 1..5.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WellbeingDoc {
    pub ulid: String,
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(rename = "recordedAt")]
    pub recorded_at: DateTime<Utc>,
    pub score: u8,
    pub note: Option<String>,
    #[serde(rename = "_deleted", default)]
    pub deleted: bool,
    #[serde(default)]
    pub rev: u64,
}

/// One to-do connection as it travels over sync. The kind/target_kind enums ride
/// as their snake_case strings; the endpoints are soft refs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoLinkDoc {
    pub ulid: String,
    #[serde(default)]
    pub id: Option<u64>,
    pub from: String,
    pub kind: String,
    #[serde(rename = "targetKind")]
    pub target_kind: String,
    #[serde(rename = "targetRef")]
    pub target_ref: String,
    #[serde(rename = "_deleted", default)]
    pub deleted: bool,
    #[serde(default)]
    pub rev: u64,
}

/// A page of pulled documents plus the advanced checkpoint.
#[derive(Debug, Serialize)]
pub struct PullResponse<D> {
    pub documents: Vec<D>,
    pub checkpoint: Checkpoint,
}

/// The opaque (to the client) pull cursor: the highest `rev` delivered so far.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Checkpoint {
    pub rev: u64,
}

/// One change pushed by the client: the desired new state, plus the master state
/// the client assumed (null for a fresh insert) — used for optimistic-concurrency
/// conflict detection. The explicit `DeserializeOwned` bound (rather than serde's
/// inferred `Deserialize<'de>`) keeps the doc type usable as a `Json` body — the
/// inferred higher-ranked bound otherwise fails to satisfy axum's extractor.
#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "D: serde::de::DeserializeOwned"))]
pub struct PushEntry<D> {
    #[serde(rename = "newDocumentState")]
    pub new_document_state: D,
    #[serde(rename = "assumedMasterState", default)]
    pub assumed_master_state: Option<D>,
}
