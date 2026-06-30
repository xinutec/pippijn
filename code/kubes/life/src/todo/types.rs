//! To-do types. A to-do is a *typed* task with an open/done status and optional
//! notes. The type is a curated enum that starts at `purchase`/`call` and grows
//! as new kinds are actually needed — not up front. Typed, directional
//! connections to other to-dos and app entities live in the `todo_link` table.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The kind of to-do. Add a variant here (plus its `Display`/`FromStr` arm) when
/// a new kind earns its place — the set is deliberately small to start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TodoType {
    Purchase,
    Call,
}

impl fmt::Display for TodoType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TodoType::Purchase => "purchase",
            TodoType::Call => "call",
        })
    }
}

impl FromStr for TodoType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "purchase" => Ok(TodoType::Purchase),
            "call" => Ok(TodoType::Call),
            other => Err(format!("unknown todo type {other:?}")),
        }
    }
}

/// Lifecycle status. Open or done for now; richer states (e.g. blocked) can be
/// added when the connection semantics call for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TodoStatus {
    Open,
    Done,
}

impl fmt::Display for TodoStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TodoStatus::Open => "open",
            TodoStatus::Done => "done",
        })
    }
}

impl FromStr for TodoStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "open" => Ok(TodoStatus::Open),
            "done" => Ok(TodoStatus::Done),
            other => Err(format!("unknown todo status {other:?}")),
        }
    }
}

/// A to-do as returned by the API.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Todo {
    #[ts(type = "number")]
    pub id: u64,
    pub title: String,
    #[serde(rename = "type")]
    pub todo_type: TodoType,
    pub status: TodoStatus,
    pub notes: Option<String>,
}

/// Request body for creating a to-do. New to-dos start `open`.
#[derive(Debug, Deserialize)]
pub struct NewTodo {
    pub title: String,
    #[serde(rename = "type")]
    pub todo_type: TodoType,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Full update (edits, the type, and the open/done toggle).
#[derive(Debug, Deserialize)]
pub struct UpdateTodo {
    pub title: String,
    #[serde(rename = "type")]
    pub todo_type: TodoType,
    pub status: TodoStatus,
    #[serde(default)]
    pub notes: Option<String>,
}
