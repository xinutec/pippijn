//! MariaDB archive store. Append-only migrations, same convention as the
//! `home`/`health` services: each entry runs exactly once, tracked by index in
//! `schema_version`. To evolve the schema, APPEND a new entry — never edit an
//! existing one.

use anyhow::Result;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};

const MIGRATIONS: &[&str] = &[
    // v0: contacts (people). Keyed by Signal ACI UUID.
    r"CREATE TABLE IF NOT EXISTS contacts (
        uuid CHAR(36) NOT NULL PRIMARY KEY,
        phone VARCHAR(32) NULL,
        profile_name VARCHAR(255) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )",
    // v1: conversations (threads). thread_id is `dm:<uuid>` or `group:<hex master key>`.
    r"CREATE TABLE IF NOT EXISTS conversations (
        thread_id VARCHAR(80) NOT NULL PRIMARY KEY,
        type ENUM('dm','group') NOT NULL,
        name VARCHAR(255) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )",
    // v2: messages. UNIQUE(sender_uuid, server_ts) is the dedupe key — a Signal
    // message timestamp is unique per sender, so the live feed and the one-time
    // history import (signalbackup-tools) can overlap safely (INSERT IGNORE).
    r"CREATE TABLE IF NOT EXISTS messages (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        thread_id VARCHAR(80) NOT NULL,
        sender_uuid CHAR(36) NOT NULL,
        server_ts BIGINT NOT NULL,
        body TEXT NULL,
        quote_target_ts BIGINT NULL,
        is_outgoing TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_sender_ts (sender_uuid, server_ts),
        INDEX idx_thread_ts (thread_id, server_ts)
    )",
    // v3: attachment metadata. Bytes are NOT downloaded in v1 (see main.rs note);
    // this records the pointer so a later pass can fetch + fill `stored_path`.
    r"CREATE TABLE IF NOT EXISTS attachments (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        message_id BIGINT NOT NULL,
        content_type VARCHAR(255) NULL,
        file_name VARCHAR(512) NULL,
        size_bytes BIGINT NULL,
        stored_path VARCHAR(1024) NULL,
        INDEX idx_msg (message_id)
    )",
    // v4: reactions (emoji), as discrete add/remove events.
    r"CREATE TABLE IF NOT EXISTS reactions (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        thread_id VARCHAR(80) NOT NULL,
        target_ts BIGINT NOT NULL,
        author_uuid CHAR(36) NOT NULL,
        emoji VARCHAR(32) NULL,
        reaction_ts BIGINT NOT NULL,
        removed TINYINT(1) NOT NULL DEFAULT 0,
        UNIQUE KEY uniq_reaction (author_uuid, target_ts, reaction_ts)
    )",
];

#[derive(Clone)]
pub struct Db {
    pool: MySqlPool,
}

impl Db {
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = MySqlPoolOptions::new().max_connections(5).connect(url).await?;
        let db = Self { pool };
        db.migrate().await?;
        Ok(db)
    }

    async fn migrate(&self) -> Result<()> {
        sqlx::query("CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY)")
            .execute(&self.pool)
            .await?;
        // Serialise migrations across restarts/replicas with an advisory lock.
        sqlx::query("SELECT GET_LOCK('signal_migrate', 30)").execute(&self.pool).await?;
        let applied: Vec<i32> =
            sqlx::query_scalar("SELECT version FROM schema_version").fetch_all(&self.pool).await?;
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let v = i as i32;
            if !applied.contains(&v) {
                tracing::info!("applying migration v{v}");
                sqlx::query(sql).execute(&self.pool).await?;
                sqlx::query("INSERT INTO schema_version (version) VALUES (?)")
                    .bind(v)
                    .execute(&self.pool)
                    .await?;
            }
        }
        sqlx::query("SELECT RELEASE_LOCK('signal_migrate')").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn upsert_conversation(&self, thread_id: &str, kind: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO conversations (thread_id, type) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP",
        )
        .bind(thread_id)
        .bind(kind)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Returns the new row id, or 0 if it was a duplicate (INSERT IGNORE).
    pub async fn insert_message(
        &self,
        thread_id: &str,
        sender_uuid: &str,
        server_ts: i64,
        body: Option<&str>,
        quote_target_ts: Option<i64>,
        is_outgoing: bool,
    ) -> Result<u64> {
        let res = sqlx::query(
            "INSERT IGNORE INTO messages
                (thread_id, sender_uuid, server_ts, body, quote_target_ts, is_outgoing)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(thread_id)
        .bind(sender_uuid)
        .bind(server_ts)
        .bind(body)
        .bind(quote_target_ts)
        .bind(is_outgoing)
        .execute(&self.pool)
        .await?;
        Ok(res.last_insert_id())
    }

    pub async fn insert_attachment(
        &self,
        message_id: u64,
        content_type: Option<&str>,
        file_name: Option<&str>,
        size_bytes: Option<i64>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO attachments (message_id, content_type, file_name, size_bytes)
             VALUES (?, ?, ?, ?)",
        )
        .bind(message_id)
        .bind(content_type)
        .bind(file_name)
        .bind(size_bytes)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_reaction(
        &self,
        thread_id: &str,
        target_ts: i64,
        author_uuid: &str,
        emoji: Option<&str>,
        reaction_ts: i64,
        removed: bool,
    ) -> Result<()> {
        sqlx::query(
            "INSERT IGNORE INTO reactions
                (thread_id, target_ts, author_uuid, emoji, reaction_ts, removed)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(thread_id)
        .bind(target_ts)
        .bind(author_uuid)
        .bind(emoji)
        .bind(reaction_ts)
        .bind(removed)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
