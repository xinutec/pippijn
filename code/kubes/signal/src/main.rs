//! signal-archiver — ingests Signal messages from `signal-cli-rest-api`'s
//! receive websocket into MariaDB, and enriches them: contact/group names,
//! sticker markers, and downloaded attachment bytes.
//!
//! Linking and the Signal protocol are handled by signal-cli-rest-api (in
//! `MODE=json-rpc`); this binary connects to its per-account receive websocket,
//! parses each frame, and archives it. signal-cli >=0.14.x links as a secondary
//! device without the capabilities/409 issue presage hit.
//!
//! Config via env: DB_HOST, DB_PORT (3306), DB_NAME, DB_USER, DB_PASSWORD,
//! SIGNAL_NUMBER (E.164, the linked account), SIGNAL_API_WS
//! (ws://signal-cli-rest-api:8080), SIGNAL_API_HTTP (http://signal-cli-rest-api:8080),
//! ATTACHMENTS_DIR (/attachments).

mod db;

use std::time::Duration;

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use db::Db;

/// Shared state passed to the per-frame handlers.
#[derive(Clone)]
struct Ctx {
    db: Db,
    http: reqwest::Client,
    http_base: String,
    number: String,
    attach_dir: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,signal_archiver=debug".into()),
        )
        .init();

    let number = std::env::var("SIGNAL_NUMBER").context("SIGNAL_NUMBER not set")?;
    let api_ws = env_or("SIGNAL_API_WS", "ws://signal-cli-rest-api:8080");
    let http_base = env_or("SIGNAL_API_HTTP", "http://signal-cli-rest-api:8080")
        .trim_end_matches('/')
        .to_string();
    let attach_dir = env_or("ATTACHMENTS_DIR", "/attachments");
    let ws_url = format!("{}/v1/receive/{}", api_ws.trim_end_matches('/'), number);

    tokio::fs::create_dir_all(&attach_dir).await.ok();

    let db = Db::connect(&database_url()?).await.context("connecting to MariaDB")?;
    let ctx = Ctx {
        db,
        http: reqwest::Client::new(),
        http_base,
        number,
        attach_dir,
    };
    tracing::info!("DB connected + migrated; ingesting from {ws_url}");

    // Background: periodically refresh group names (the receive payload only
    // carries the group id, not its title).
    tokio::spawn(refresh_group_names(ctx.clone()));

    // Reconnect forever — the websocket drops on signal-cli restarts / blips.
    loop {
        match run_ws(&ws_url, &ctx).await {
            Ok(()) => tracing::warn!("receive stream ended; reconnecting in 7s"),
            Err(e) => tracing::error!("websocket error: {e:#}; reconnecting in 10s"),
        }
        tokio::time::sleep(Duration::from_secs(7)).await;
    }
}

async fn run_ws(ws_url: &str, ctx: &Ctx) -> Result<()> {
    let (mut ws, _) = connect_async(ws_url).await.context("ws connect")?;
    tracing::info!("websocket connected");
    while let Some(msg) = ws.next().await {
        let msg = msg.context("ws read")?;
        if msg.is_close() {
            tracing::warn!("server closed the websocket");
            break;
        }
        if msg.is_ping() {
            ws.send(Message::Pong(msg.into_data())).await.ok();
            continue;
        }
        let text = match msg.to_text() {
            Ok(t) if !t.trim().is_empty() => t,
            _ => continue,
        };
        // Tolerate the occasional malformed frame rather than killing the loop.
        let frame: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("skipping non-JSON frame: {e}");
                continue;
            }
        };
        if let Err(e) = handle(ctx, &frame).await {
            tracing::warn!("failed to archive a frame: {e:#}");
        }
    }
    Ok(())
}

/// Archive one received frame. Accepts both the unwrapped `{"envelope": {...}}`
/// shape and a JSON-RPC `{"params": {"envelope": {...}}}` notification.
async fn handle(ctx: &Ctx, frame: &Value) -> Result<()> {
    let env = frame
        .get("envelope")
        .or_else(|| frame.get("params").and_then(|p| p.get("envelope")));
    let Some(env) = env else { return Ok(()) };

    if let Some(dm) = env.get("dataMessage") {
        let sender = id_of(env.get("sourceUuid"), env.get("source"));
        let ts = env
            .get("timestamp")
            .and_then(Value::as_i64)
            .or_else(|| dm.get("timestamp").and_then(Value::as_i64))
            .unwrap_or(0);
        // The sender's name/number ride along in the envelope — record them.
        let name = env.get("sourceName").and_then(Value::as_str);
        let phone = env.get("sourceNumber").and_then(Value::as_str);
        ctx.db.upsert_contact(&sender, phone, name).await.ok();
        let dm_thread = format!("dm:{sender}");
        // Name a DM thread after the other party.
        if dm.get("groupInfo").is_none() {
            if let Some(n) = name {
                ctx.db.set_conversation_name(&dm_thread, n).await.ok();
            }
        }
        store(ctx, dm, &sender, ts, false, &dm_thread).await?;
        return Ok(());
    }

    if let Some(sent) = env.get("syncMessage").and_then(|s| s.get("sentMessage")) {
        let sender = id_of(env.get("sourceUuid"), env.get("source")); // ourselves
        let ts = sent.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
        let dest = id_of(sent.get("destinationUuid"), sent.get("destination"));
        store(ctx, sent, &sender, ts, true, &format!("dm:{dest}")).await?;
        return Ok(());
    }

    Ok(())
}

/// dataMessage and sentMessage share field names, so one routine handles both.
async fn store(
    ctx: &Ctx,
    msg: &Value,
    sender: &str,
    ts: i64,
    is_outgoing: bool,
    dm_thread_id: &str,
) -> Result<()> {
    let (thread_id, kind) = match msg
        .get("groupInfo")
        .and_then(|g| g.get("groupId"))
        .and_then(Value::as_str)
    {
        Some(gid) => (format!("group:{gid}"), "group"),
        None => (dm_thread_id.to_string(), "dm"),
    };
    ctx.db.upsert_conversation(&thread_id, kind).await?;

    // A reaction carries no body of its own.
    if let Some(reaction) = msg.get("reaction") {
        if let Some(target) = reaction.get("targetSentTimestamp").and_then(Value::as_i64) {
            ctx.db
                .insert_reaction(
                    &thread_id,
                    target,
                    sender,
                    reaction.get("emoji").and_then(Value::as_str),
                    ts,
                    reaction.get("isRemove").and_then(Value::as_bool).unwrap_or(false),
                )
                .await?;
        }
        return Ok(());
    }

    // Text body, or a marker for a sticker-only message (otherwise NULL).
    let text = msg.get("message").and_then(Value::as_str);
    let sticker_marker;
    let body = match text {
        Some(t) => Some(t),
        None if msg.get("sticker").is_some() => {
            let emoji = msg
                .get("sticker")
                .and_then(|s| s.get("emoji"))
                .and_then(Value::as_str)
                .unwrap_or("");
            sticker_marker = format!("[sticker {emoji}]");
            Some(sticker_marker.as_str())
        }
        None => None,
    };
    let quote = msg.get("quote").and_then(|q| q.get("id")).and_then(Value::as_i64);
    let msg_id = ctx.db.insert_message(&thread_id, sender, ts, body, quote, is_outgoing).await?;

    // msg_id == 0 means a duplicate (INSERT IGNORE) — skip children.
    if msg_id != 0 {
        if let Some(atts) = msg.get("attachments").and_then(Value::as_array) {
            for att in atts {
                let stored = match att.get("id").and_then(Value::as_str) {
                    Some(id) => download_attachment(ctx, id).await,
                    None => None,
                };
                ctx.db
                    .insert_attachment(
                        msg_id,
                        att.get("contentType").and_then(Value::as_str),
                        att.get("filename").and_then(Value::as_str),
                        att.get("size").and_then(Value::as_i64),
                        stored.as_deref(),
                    )
                    .await?;
            }
        }
    }
    Ok(())
}

/// Best-effort: fetch the attachment blob from the rest-api and store it.
/// Returns the on-disk path, or None on any failure (metadata is still kept).
async fn download_attachment(ctx: &Ctx, id: &str) -> Option<String> {
    let url = format!("{}/v1/attachments/{}", ctx.http_base, id);
    let resp = ctx.http.get(&url).timeout(Duration::from_secs(30)).send().await.ok()?;
    if !resp.status().is_success() {
        tracing::warn!("attachment {id} fetch returned {}", resp.status());
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let path = format!("{}/{}", ctx.attach_dir, safe);
    match tokio::fs::write(&path, &bytes).await {
        Ok(()) => Some(path),
        Err(e) => {
            tracing::warn!("writing attachment {id} failed: {e}");
            None
        }
    }
}

/// Periodically pull group titles (the receive payload only carries the id).
async fn refresh_group_names(ctx: Ctx) {
    let url = format!("{}/v1/groups/{}", ctx.http_base, ctx.number);
    loop {
        if let Ok(resp) = ctx.http.get(&url).timeout(Duration::from_secs(20)).send().await {
            if let Ok(bytes) = resp.bytes().await {
                if let Ok(Value::Array(groups)) = serde_json::from_slice::<Value>(&bytes) {
                    for g in &groups {
                        if let (Some(iid), Some(name)) = (
                            g.get("internal_id").and_then(Value::as_str),
                            g.get("name").and_then(Value::as_str),
                        ) {
                            ctx.db.set_conversation_name(&format!("group:{iid}"), name).await.ok();
                        }
                    }
                    tracing::debug!("refreshed {} group name(s)", groups.len());
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(600)).await;
    }
}

/// Prefer the stable ACI UUID; fall back to the E.164 number, then "unknown".
fn id_of(uuid: Option<&Value>, fallback: Option<&Value>) -> String {
    uuid.and_then(Value::as_str)
        .or_else(|| fallback.and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_string()
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn database_url() -> Result<String> {
    let host = std::env::var("DB_HOST").context("DB_HOST not set")?;
    let port = env_or("DB_PORT", "3306");
    let name = std::env::var("DB_NAME").context("DB_NAME not set")?;
    let user = std::env::var("DB_USER").context("DB_USER not set")?;
    let pass = std::env::var("DB_PASSWORD").context("DB_PASSWORD not set")?;
    Ok(format!("mysql://{user}:{pass}@{host}:{port}/{name}"))
}
