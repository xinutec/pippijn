//! The trash: everything the user deleted, restorable. Deletes anywhere in the
//! app only ever tombstone (`deleted_at`); this module lists those tombstones
//! across all entity kinds and clears them again on restore. Nothing is purged.
//!
//! For the synced entities (shopping/to-do) a restore bumps the global `rev`,
//! so the resurrected row propagates to every device through the normal pull.
//! The sync push path itself can never clear a tombstone (set-only, see
//! `sync::repo`) — this explicit restore is the one deliberate undelete.

pub mod repo;

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which table a trash entry lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TrashKind {
    Item,
    Location,
    Recipe,
    Shopping,
    Todo,
    Wellbeing,
}

impl fmt::Display for TrashKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            TrashKind::Item => "item",
            TrashKind::Location => "location",
            TrashKind::Recipe => "recipe",
            TrashKind::Shopping => "shopping",
            TrashKind::Todo => "todo",
            TrashKind::Wellbeing => "wellbeing",
        };
        f.write_str(s)
    }
}

impl FromStr for TrashKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "item" => Ok(TrashKind::Item),
            "location" => Ok(TrashKind::Location),
            "recipe" => Ok(TrashKind::Recipe),
            "shopping" => Ok(TrashKind::Shopping),
            "todo" => Ok(TrashKind::Todo),
            "wellbeing" => Ok(TrashKind::Wellbeing),
            other => Err(format!("unknown trash kind {other:?}")),
        }
    }
}

/// One deleted thing, as shown on the trash screen. `ref_` identifies the row
/// within its kind: the numeric id for REST entities (item/location/recipe),
/// the ULID for synced ones (shopping/todo) — ids can be absent client-side
/// for never-synced rows, ULIDs never are.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct TrashEntry {
    pub kind: TrashKind,
    #[serde(rename = "ref")]
    #[ts(rename = "ref")]
    pub ref_: String,
    pub name: String,
    /// When it was deleted, Unix milliseconds (UTC).
    #[ts(type = "number")]
    pub deleted_at: i64,
}
