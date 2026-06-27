//! signal-archiver — links as a Signal *secondary* device (presage) and writes
//! every received message into MariaDB.
//!
//! Subcommands:
//!   run   (default)  load the linked device and stream messages into the DB.
//!                    If the store is not yet linked, it links first (prints the
//!                    provisioning URL to stdout) and then starts receiving.
//!   link             link only: print the provisioning URL and exit once paired.
//!
//! Linking shows a `sgnl://linkdevice?...` URL on stdout. Render it as a QR
//! (e.g. `kubectl logs` → `qrencode -t ANSIUTF8 '<url>'`) and scan it in
//! Signal → Settings → Linked devices.
//!
//! Config via env: DB_HOST, DB_PORT (3306), DB_NAME, DB_USER, DB_PASSWORD,
//! SIGNAL_STORE_PATH (/data/store), SIGNAL_DEVICE_NAME (signal-archiver),
//! STORE_PASSPHRASE (optional — encrypts the local presage store).

mod db;

use std::time::Duration;

use anyhow::{Context, Result};
use futures::{channel::oneshot, future, pin_mut, StreamExt};

use presage::libsignal_service::configuration::SignalServers;
use presage::libsignal_service::content::{Content, ContentBody};
use presage::manager::Registered;
use presage::model::identity::OnNewIdentity;
use presage::model::messages::Received;
use presage::store::Thread;
use presage::Manager;
use presage_store_sled::{MigrationConflictStrategy, SledStore};

use db::Db;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,signal_archiver=debug".into()),
        )
        .init();

    let link_only = matches!(std::env::args().nth(1).as_deref(), Some("link"));

    let store_path = env_or("SIGNAL_STORE_PATH", "/data/store");
    let device_name = env_or("SIGNAL_DEVICE_NAME", "signal-archiver");
    let passphrase = std::env::var("STORE_PASSPHRASE").ok().filter(|s| !s.is_empty());

    let store = SledStore::open_with_passphrase(
        &store_path,
        passphrase,
        MigrationConflictStrategy::Raise,
        OnNewIdentity::Trust,
    )
    .await
    .context("opening sled store")?;

    // Load the existing registration, or link as a new secondary device.
    let manager = match Manager::load_registered(store.clone()).await {
        Ok(m) => {
            if link_only {
                tracing::info!("already linked; nothing to do");
                return Ok(());
            }
            tracing::info!("loaded existing linked device");
            m
        }
        Err(_) => {
            tracing::info!("not linked yet — starting secondary-device linking");
            let m = link(store, device_name).await?;
            tracing::info!("linked successfully");
            if link_only {
                return Ok(());
            }
            m
        }
    };

    let db_url = database_url()?;
    let db = Db::connect(&db_url).await.context("connecting to MariaDB")?;
    tracing::info!("DB connected + migrated; entering receive loop");

    receive_loop(manager, db).await
}

async fn link(store: SledStore, device_name: String) -> Result<Manager<SledStore, Registered>> {
    let (tx, rx) = oneshot::channel();
    let (res, _) = future::join(
        Manager::link_secondary_device(store, SignalServers::Production, device_name, tx),
        async move {
            match rx.await {
                Ok(url) => {
                    // Printed (not logged) so it's easy to copy out of `kubectl logs`.
                    println!(
                        "\n=== SIGNAL LINK URL — render as QR and scan in Signal > Linked devices ===\n{url}\n=== (waiting for the phone to confirm) ===\n"
                    );
                }
                Err(e) => tracing::error!("provisioning channel dropped: {e}"),
            }
        },
    )
    .await;
    Ok(res?)
}

/// Stream messages forever, reconnecting when the websocket drops.
async fn receive_loop(mut manager: Manager<SledStore, Registered>, db: Db) -> Result<()> {
    loop {
        match manager.receive_messages().await {
            Ok(stream) => {
                pin_mut!(stream);
                while let Some(received) = stream.next().await {
                    match received {
                        Received::QueueEmpty => tracing::debug!("caught up with the queue"),
                        Received::Contacts => tracing::debug!("contacts sync complete"),
                        Received::Content(content) => {
                            if let Err(e) = handle(&db, &content).await {
                                tracing::warn!("failed to archive a message: {e:#}");
                            }
                        }
                    }
                }
                tracing::warn!("receive stream ended; reconnecting in 5s");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            Err(e) => {
                tracing::error!("receive_messages failed: {e}; retrying in 15s");
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        }
    }
}

/// Persist a single incoming message. v1 handles incoming DataMessages (text,
/// quote, attachment metadata, reactions). NOTE: attachment *bytes* and
/// reaction-target lookups need `&manager`, which is borrowed mutably by the
/// receive stream — so they're deferred to a later pass (see README). Outgoing
/// messages (SynchronizeMessage/Sent sync) are also a follow-up.
async fn handle(db: &Db, content: &Content) -> Result<()> {
    let sender = content.metadata.sender.raw_uuid().to_string();
    let ts = content.metadata.timestamp as i64;

    let (thread_id, kind) = match Thread::try_from(content) {
        Ok(Thread::Contact(uuid)) => (format!("dm:{uuid}"), "dm"),
        Ok(Thread::Group(key)) => (format!("group:{}", hex::encode(key)), "group"),
        Err(_) => (format!("dm:{sender}"), "dm"),
    };

    let ContentBody::DataMessage(dm) = &content.body else {
        return Ok(());
    };
    db.upsert_conversation(&thread_id, kind).await?;

    // A reaction carries no body of its own.
    if let Some(reaction) = &dm.reaction {
        if let Some(target) = reaction.target_sent_timestamp {
            db.insert_reaction(
                &thread_id,
                target as i64,
                &sender,
                reaction.emoji.as_deref(),
                ts,
                reaction.remove.unwrap_or(false),
            )
            .await?;
        }
        return Ok(());
    }

    let quote_target = dm.quote.as_ref().and_then(|q| q.id).map(|id| id as i64);
    let msg_id = db
        .insert_message(&thread_id, &sender, ts, dm.body.as_deref(), quote_target, false)
        .await?;

    // msg_id == 0 means it was a duplicate (already archived) — skip children.
    if msg_id != 0 {
        for att in &dm.attachments {
            db.insert_attachment(
                msg_id,
                att.content_type.as_deref(),
                att.file_name.as_deref(),
                att.size.map(|s| s as i64),
            )
            .await?;
        }
    }
    Ok(())
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
