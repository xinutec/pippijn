//! To-do types. A to-do is a *typed* task with an open/done status and optional
//! notes. The type is a curated enum that starts at `purchase`/`call` and grows
//! as new kinds are actually needed — not up front. Typed, directional
//! connections to other to-dos and app entities live in the `todo_link` table.

use std::fmt;
use std::str::FromStr;

use chrono::NaiveDate;
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
    Appointment,
    Admin,
    Task,
}

impl fmt::Display for TodoType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TodoType::Purchase => "purchase",
            TodoType::Call => "call",
            TodoType::Appointment => "appointment",
            TodoType::Admin => "admin",
            TodoType::Task => "task",
        })
    }
}

impl FromStr for TodoType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "purchase" => Ok(TodoType::Purchase),
            "call" => Ok(TodoType::Call),
            "appointment" => Ok(TodoType::Appointment),
            "admin" => Ok(TodoType::Admin),
            "task" => Ok(TodoType::Task),
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

/// Triage priority. Optional on a to-do (`None` = unprioritised, sorts last).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TodoPriority {
    High,
    Medium,
    Low,
}

impl fmt::Display for TodoPriority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TodoPriority::High => "high",
            TodoPriority::Medium => "medium",
            TodoPriority::Low => "low",
        })
    }
}

impl FromStr for TodoPriority {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "high" => Ok(TodoPriority::High),
            "medium" => Ok(TodoPriority::Medium),
            "low" => Ok(TodoPriority::Low),
            other => Err(format!("unknown todo priority {other:?}")),
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
    pub priority: Option<TodoPriority>,
    pub notes: Option<String>,
    /// Start-gate: don't surface / can't act before this day (drives "waiting";
    /// doubles as snooze). `None` = no gate.
    #[serde(rename = "notBefore")]
    pub not_before: Option<NaiveDate>,
    /// Deadline (drives urgency ordering). `None` = no deadline.
    pub due: Option<NaiveDate>,
}

/// Request body for creating a to-do. New to-dos start `open`.
#[derive(Debug, Deserialize)]
pub struct NewTodo {
    pub title: String,
    #[serde(rename = "type")]
    pub todo_type: TodoType,
    #[serde(default)]
    pub priority: Option<TodoPriority>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(rename = "notBefore", default)]
    pub not_before: Option<NaiveDate>,
    #[serde(default)]
    pub due: Option<NaiveDate>,
}

/// Full update (edits, the type, the priority, the timing, and open/done).
#[derive(Debug, Deserialize)]
pub struct UpdateTodo {
    pub title: String,
    #[serde(rename = "type")]
    pub todo_type: TodoType,
    pub status: TodoStatus,
    #[serde(default)]
    pub priority: Option<TodoPriority>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(rename = "notBefore", default)]
    pub not_before: Option<NaiveDate>,
    #[serde(default)]
    pub due: Option<NaiveDate>,
}

/// How a to-do connects to its target. Directional: the edge runs *from* the
/// to-do *to* the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LinkKind {
    /// The to-do depends on the target (target should come first / blocks it).
    DependsOn,
    /// The target is a sub-task of the to-do (parent → child).
    Subtask,
    /// A plain association, no ordering implied.
    Related,
}

impl fmt::Display for LinkKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            LinkKind::DependsOn => "depends_on",
            LinkKind::Subtask => "subtask",
            LinkKind::Related => "related",
        })
    }
}

impl FromStr for LinkKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "depends_on" => Ok(LinkKind::DependsOn),
            "subtask" => Ok(LinkKind::Subtask),
            "related" => Ok(LinkKind::Related),
            other => Err(format!("unknown link kind {other:?}")),
        }
    }
}

/// What a connection points at. A target is referenced *softly* — by `ulid`
/// (another to-do), DB id (an app entity), or room name (a house room) — never a
/// hard FK, so links sync independently of their endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TargetKind {
    Todo,
    Item,
    Recipe,
    Room,
    Shopping,
    Place,
}

impl fmt::Display for TargetKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TargetKind::Todo => "todo",
            TargetKind::Item => "item",
            TargetKind::Recipe => "recipe",
            TargetKind::Room => "room",
            TargetKind::Shopping => "shopping",
            TargetKind::Place => "place",
        })
    }
}

impl FromStr for TargetKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "todo" => Ok(TargetKind::Todo),
            "item" => Ok(TargetKind::Item),
            "recipe" => Ok(TargetKind::Recipe),
            "room" => Ok(TargetKind::Room),
            "shopping" => Ok(TargetKind::Shopping),
            "place" => Ok(TargetKind::Place),
            other => Err(format!("unknown target kind {other:?}")),
        }
    }
}

/// A typed, directional connection as returned by the API.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct TodoLink {
    #[ts(type = "number")]
    pub id: u64,
    /// `ulid` of the source to-do.
    pub from: String,
    pub kind: LinkKind,
    #[serde(rename = "targetKind")]
    pub target_kind: TargetKind,
    /// The target's ulid / id-string / room name (per `target_kind`).
    #[serde(rename = "targetRef")]
    pub target_ref: String,
}

/// Request body for creating a connection.
#[derive(Debug, Deserialize)]
pub struct NewTodoLink {
    pub from: String,
    pub kind: LinkKind,
    #[serde(rename = "targetKind")]
    pub target_kind: TargetKind,
    #[serde(rename = "targetRef")]
    pub target_ref: String,
}
