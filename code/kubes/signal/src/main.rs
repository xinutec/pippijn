//! signal-archiver — ingests Signal messages from `signal-cli-rest-api`'s
//! receive websocket and writes them into MariaDB.
//!
//! Linking and the Signal protocol are handled by signal-cli-rest-api (in
//! `MODE=json-rpc`); this binary just connects to its per-account receive
//! websocket, parses each frame, and archives it. signal-cli ≥0.14.x links as a
//! secondary device without the capabilities/409 issue presage hit.
//!
//! Config via env: DB_HOST, DB_PORT (3306), DB_NAME, DB_USER, DB_PASSWORD,
//! SIGNAL_NUMBER (E.164, the linked account), SIGNAL_API_WS
//! (ws://signal-cli-rest-api:8080).

mod db;

use std::time::Duration;

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use db::Db;

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
    let ws_url = format!("{}/v1/receive/{}", api_ws.trim_end_matches('/'), number);

    let db = Db::connect(&database_url()?).await.context("connecting to MariaDB")?;
    tracing::info!("DB connected + migrated; ingesting from {ws_url}");

    // Reconnect forever — the websocket drops on signal-cli restarts / network blips.
    loop {
        match run_ws(&ws_url, &db).await {
            Ok(()) => tracing::warn!("receive stream ended; reconnecting in 7s"),
            Err(e) => tracing::error!("websocket error: {e:#}; reconnecting in 10s"),
        }
        tokio::time::sleep(Duration::from_secs(7)).await;
    }
}

async fn run_ws(ws_url: &str, db: &Db) -> Result<()> {
    let (mut ws, _) = connect_async(ws_url).await.context("ws connect")?;
    tracing::info!("websocket connected");
    while let Some(msg) = ws.next().await {
        let msg = msg.context("ws read")?;
        if msg.is_close() {
            tracing::warn!("server closed the websocket");
            break;
        }
        if msg.is_ping() {
            // Keep the connection alive — signal-cli-rest-api pings periodically.
            ws.send(Message::Pong(msg.into_data())).await.ok();
            continue;
        }
        let text = match msg.to_text() {
            Ok(t) if !t.trim().is_empty() => t,
            _ => continue,
        };
        // Tolerate the occasional malformed frame (e.g. the historical broken
        // reaction-JSON bug) rather than killing the loop.
        let frame: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("skipping non-JSON frame: {e}");
                continue;
            }
        };
        if let Err(e) = handle(db, &frame).await {
            tracing::warn!("failed to archive a frame: {e:#}");
        }
    }
    Ok(())
}

/// Archive one received frame. signal-cli-rest-api pushes either the unwrapped
/// `{"envelope": {...}}` shape or a JSON-RPC `{"params": {"envelope": {...}}}`
/// notification — accept both. Each envelope carries exactly one of
/// dataMessage (incoming) / syncMessage.sentMessage (own outgoing) / receipt /
/// typing; we archive the first two and ignore the rest.
async fn handle(db: &Db, frame: &Value) -> Result<()> {
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
        // A DM thread is keyed by the other party (the sender).
        store(db, dm, &sender, ts, false, &format!("dm:{sender}")).await?;
        return Ok(());
    }

    if let Some(sent) = env.get("syncMessage").and_then(|s| s.get("sentMessage")) {
        let sender = id_of(env.get("sourceUuid"), env.get("source")); // ourselves
        let ts = sent.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
        let dest = id_of(sent.get("destinationUuid"), sent.get("destination"));
        // Outgoing DM belongs to the same thread as the recipient's incoming.
        store(db, sent, &sender, ts, true, &format!("dm:{dest}")).await?;
        return Ok(());
    }

    Ok(())
}

/// dataMessage and sentMessage share field names (message/groupInfo/quote/
/// reaction/attachments), so one routine handles both.
async fn store(
    db: &Db,
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
    db.upsert_conversation(&thread_id, kind).await?;

    // A reaction carries no body of its own.
    if let Some(reaction) = msg.get("reaction") {
        if let Some(target) = reaction.get("targetSentTimestamp").and_then(Value::as_i64) {
            db.insert_reaction(
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

    let body = msg.get("message").and_then(Value::as_str);
    let quote = msg.get("quote").and_then(|q| q.get("id")).and_then(Value::as_i64);
    let msg_id = db.insert_message(&thread_id, sender, ts, body, quote, is_outgoing).await?;

    // msg_id == 0 means a duplicate (INSERT IGNORE) — skip children.
    if msg_id != 0 {
        if let Some(atts) = msg.get("attachments").and_then(Value::as_array) {
            for att in atts {
                db.insert_attachment(
                    msg_id,
                    att.get("contentType").and_then(Value::as_str),
                    att.get("filename").and_then(Value::as_str),
                    att.get("size").and_then(Value::as_i64),
                )
                .await?;
            }
        }
    }
    Ok(())
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
