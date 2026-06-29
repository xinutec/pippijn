//! Read-only queries over the message archive, normalising the two origins
//! (Signal + Google Chat) into one shape for the UI.
//!
//! The origins differ: Signal keeps per-author reaction *events* (add/remove)
//! and message edit/delete flags; Google Chat keeps *aggregated* emoji counts,
//! Google threading and a numeric sender id. This module hides those behind a
//! common `Conversation` / `Message` so the frontend has one model. All access
//! is SELECT-only; nothing here writes to the archive tables.

use anyhow::Result;
use serde::Serialize;
use sqlx::{AssertSqlSafe, MySqlPool, Row};

pub const ORIGIN_SIGNAL: &str = "signal";
pub const ORIGIN_GCHAT: &str = "gchat";

pub fn valid_origin(origin: &str) -> bool {
    origin == ORIGIN_SIGNAL || origin == ORIGIN_GCHAT
}

#[derive(Serialize)]
pub struct Conversation {
    pub origin: String,
    pub id: String,
    pub name: Option<String>,
    pub kind: String, // "dm" | "group"
    pub message_count: i64,
    pub last_ts: Option<i64>, // ms epoch
}

#[derive(Serialize)]
pub struct Reaction {
    pub emoji: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct Message {
    pub id: String,
    pub ts: i64, // ms epoch
    pub sender: String,
    pub is_outgoing: bool,
    pub body: Option<String>,
    pub deleted: bool,
    pub edited: bool,
    pub reactions: Vec<Reaction>,
}

#[derive(Serialize)]
pub struct MessagesPage {
    pub messages: Vec<Message>, // ascending by ts
    pub has_more: bool,
    pub next_before: Option<i64>, // cursor (ms) to fetch older
}

/// All conversations across both origins, newest activity first.
pub async fn list_conversations(pool: &MySqlPool) -> Result<Vec<Conversation>> {
    let mut out = Vec::new();

    let signal = sqlx::query(
        r"SELECT c.thread_id AS id, c.type AS kind, c.name AS name,
                 COUNT(m.id) AS cnt, MAX(m.server_ts) AS last_ts
          FROM conversations c
          LEFT JOIN messages m ON m.thread_id = c.thread_id
          GROUP BY c.thread_id, c.type, c.name",
    )
    .fetch_all(pool)
    .await?;
    for r in signal {
        out.push(Conversation {
            origin: ORIGIN_SIGNAL.into(),
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            kind: r.try_get("kind")?,
            message_count: r.try_get("cnt")?,
            last_ts: r.try_get("last_ts")?,
        });
    }

    let gchat = sqlx::query(
        r"SELECT g.group_id AS id, g.name AS name, g.is_dm AS is_dm,
                 COUNT(m.id) AS cnt, MAX(m.ts_us) AS last_ts_us
          FROM gchat_conversations g
          LEFT JOIN gchat_messages m ON m.group_id = g.group_id
          GROUP BY g.group_id, g.name, g.is_dm",
    )
    .fetch_all(pool)
    .await?;
    for r in gchat {
        let is_dm: i8 = r.try_get("is_dm")?;
        let last_us: Option<i64> = r.try_get("last_ts_us")?;
        out.push(Conversation {
            origin: ORIGIN_GCHAT.into(),
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            kind: if is_dm != 0 { "dm".into() } else { "group".into() },
            message_count: r.try_get("cnt")?,
            last_ts: last_us.map(|u| u / 1000),
        });
    }

    out.sort_by(|a, b| b.last_ts.cmp(&a.last_ts));
    Ok(out)
}

/// One page of a conversation, oldest→newest, with reactions attached.
/// `before` (ms) pages backwards in time; None starts at the most recent.
pub async fn messages_page(
    pool: &MySqlPool,
    origin: &str,
    id: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<MessagesPage> {
    let mut msgs = match origin {
        ORIGIN_SIGNAL => signal_messages(pool, id, before, limit).await?,
        ORIGIN_GCHAT => gchat_messages(pool, id, before, limit).await?,
        _ => Vec::new(),
    };
    // Fetched DESC (newest first); has_more if we filled the page.
    let has_more = msgs.len() as i64 == limit;
    let next_before = msgs.last().map(|m| m.ts);
    msgs.reverse(); // present ascending
    Ok(MessagesPage { messages: msgs, has_more, next_before })
}

async fn signal_messages(
    pool: &MySqlPool,
    thread_id: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>> {
    let rows = sqlx::query(
        r"SELECT m.id AS id, m.server_ts AS ts,
                 COALESCE(ct.profile_name, m.sender_uuid) AS sender,
                 m.is_outgoing AS is_outgoing, m.body AS body,
                 m.deleted AS deleted, m.edited AS edited
          FROM messages m
          LEFT JOIN contacts ct ON ct.uuid = m.sender_uuid
          WHERE m.thread_id = ? AND (? IS NULL OR m.server_ts < ?)
          ORDER BY m.server_ts DESC
          LIMIT ?",
    )
    .bind(thread_id)
    .bind(before)
    .bind(before)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut msgs = Vec::with_capacity(rows.len());
    let mut ts_list = Vec::with_capacity(rows.len());
    for r in rows {
        let id: i64 = r.try_get("id")?;
        let ts: i64 = r.try_get("ts")?;
        let is_outgoing: i8 = r.try_get("is_outgoing")?;
        let deleted: i8 = r.try_get("deleted")?;
        let edited: i8 = r.try_get("edited")?;
        ts_list.push(ts);
        msgs.push(Message {
            id: id.to_string(),
            ts,
            sender: r.try_get("sender")?,
            is_outgoing: is_outgoing != 0,
            body: r.try_get("body")?,
            deleted: deleted != 0,
            edited: edited != 0,
            reactions: Vec::new(),
        });
    }

    // Reactions key on (thread_id, target_ts=message server_ts). Approximate the
    // live state as distinct non-removed authors per emoji (ignores the rare
    // add-then-remove of the same author within the page).
    if !ts_list.is_empty() {
        let placeholders = vec!["?"; ts_list.len()].join(",");
        let sql = format!(
            "SELECT target_ts, emoji, COUNT(DISTINCT author_uuid) AS cnt
             FROM reactions
             WHERE thread_id = ? AND removed = 0 AND emoji IS NOT NULL
               AND target_ts IN ({placeholders})
             GROUP BY target_ts, emoji",
        );
        // `sql` is a fixed template with a computed count of `?` placeholders and
        // no interpolated data; all values are bound. Safe to assert.
        let mut q = sqlx::query(AssertSqlSafe(sql)).bind(thread_id);
        for ts in &ts_list {
            q = q.bind(ts);
        }
        let rrows = q.fetch_all(pool).await?;
        for rr in rrows {
            let target_ts: i64 = rr.try_get("target_ts")?;
            let emoji: String = rr.try_get("emoji")?;
            let count: i64 = rr.try_get("cnt")?;
            if let Some(m) = msgs.iter_mut().find(|m| m.ts == target_ts) {
                m.reactions.push(Reaction { emoji, count });
            }
        }
    }
    Ok(msgs)
}

async fn gchat_messages(
    pool: &MySqlPool,
    group_id: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>> {
    let before_us = before.map(|ms| ms * 1000);
    let rows = sqlx::query(
        r"SELECT m.id AS id, m.ts_us AS ts_us, m.sender_name AS sender,
                 m.is_self AS is_self, m.text AS body
          FROM gchat_messages m
          WHERE m.group_id = ? AND (? IS NULL OR m.ts_us < ?)
          ORDER BY m.ts_us DESC
          LIMIT ?",
    )
    .bind(group_id)
    .bind(before_us)
    .bind(before_us)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut msgs = Vec::with_capacity(rows.len());
    let mut ids = Vec::with_capacity(rows.len());
    for r in rows {
        let id: i64 = r.try_get("id")?;
        let ts_us: i64 = r.try_get("ts_us")?;
        let is_self: i8 = r.try_get("is_self")?;
        ids.push(id);
        msgs.push(Message {
            id: id.to_string(),
            ts: ts_us / 1000,
            sender: r.try_get::<Option<String>, _>("sender")?.unwrap_or_default(),
            is_outgoing: is_self != 0,
            body: r.try_get("body")?,
            deleted: false,
            edited: false,
            reactions: Vec::new(),
        });
    }

    if !ids.is_empty() {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT message_id, emoji, cnt FROM gchat_reactions
             WHERE emoji IS NOT NULL AND message_id IN ({placeholders})",
        );
        // Fixed template + computed placeholder count, values bound — safe.
        let mut q = sqlx::query(AssertSqlSafe(sql));
        for id in &ids {
            q = q.bind(id);
        }
        let rrows = q.fetch_all(pool).await?;
        for rr in rrows {
            let mid: i64 = rr.try_get("message_id")?;
            let emoji: String = rr.try_get("emoji")?;
            let count: i64 = rr.try_get("cnt")?;
            let mid = mid.to_string();
            if let Some(m) = msgs.iter_mut().find(|m| m.id == mid) {
                m.reactions.push(Reaction { emoji, count });
            }
        }
    }
    Ok(msgs)
}

#[derive(Serialize)]
pub struct SearchHit {
    pub origin: String,
    pub conversation_id: String,
    pub conversation_name: Option<String>,
    pub ts: i64,
    pub sender: String,
    pub snippet: String,
}

/// Simple substring search across both origins' message text. Newest first.
pub async fn search(pool: &MySqlPool, q: &str, limit: i64) -> Result<Vec<SearchHit>> {
    let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
    let mut hits = Vec::new();

    let srows = sqlx::query(
        r"SELECT m.thread_id AS cid, c.name AS cname, m.server_ts AS ts,
                 COALESCE(ct.profile_name, m.sender_uuid) AS sender, m.body AS body
          FROM messages m
          LEFT JOIN conversations c ON c.thread_id = m.thread_id
          LEFT JOIN contacts ct ON ct.uuid = m.sender_uuid
          WHERE m.deleted = 0 AND m.body LIKE ?
          ORDER BY m.server_ts DESC LIMIT ?",
    )
    .bind(&like)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    for r in srows {
        hits.push(SearchHit {
            origin: ORIGIN_SIGNAL.into(),
            conversation_id: r.try_get("cid")?,
            conversation_name: r.try_get("cname")?,
            ts: r.try_get("ts")?,
            sender: r.try_get("sender")?,
            snippet: r.try_get::<Option<String>, _>("body")?.unwrap_or_default(),
        });
    }

    let grows = sqlx::query(
        r"SELECT m.group_id AS cid, g.name AS cname, m.ts_us AS ts_us,
                 m.sender_name AS sender, m.text AS body
          FROM gchat_messages m
          LEFT JOIN gchat_conversations g ON g.group_id = m.group_id
          WHERE m.text LIKE ?
          ORDER BY m.ts_us DESC LIMIT ?",
    )
    .bind(&like)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    for r in grows {
        let ts_us: i64 = r.try_get("ts_us")?;
        hits.push(SearchHit {
            origin: ORIGIN_GCHAT.into(),
            conversation_id: r.try_get("cid")?,
            conversation_name: r.try_get("cname")?,
            ts: ts_us / 1000,
            sender: r.try_get::<Option<String>, _>("sender")?.unwrap_or_default(),
            snippet: r.try_get::<Option<String>, _>("body")?.unwrap_or_default(),
        });
    }

    hits.sort_by(|a, b| b.ts.cmp(&a.ts));
    hits.truncate(limit as usize);
    Ok(hits)
}
