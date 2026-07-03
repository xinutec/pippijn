//! Runtime configuration, read from the environment at startup.
//!
//! The ingest tokens come from the environment (a k8s secret in deployment, a
//! `.env`-style shell locally). Nothing here is hard-coded.

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct Config {
    /// MariaDB connection string, e.g. `mysql://pulse:pw@host/pulse`.
    pub database_url: String,
    /// Address to bind the HTTP server to.
    pub bind_addr: String,

    /// Directory of the built Angular bundle to serve (with SPA fallback). When
    /// unset the server is API-only — e.g. in dev, where `ng serve` proxies.
    pub static_dir: Option<String>,

    /// Ingest credentials: `(source, token)` pairs. A producer authenticates a
    /// POST /api/reports with `Authorization: Bearer <token>`; the matching
    /// `source` is stamped server-side (see `auth`), so a producer can only ever
    /// write as itself and never spoof another machine's status.
    pub tokens: Vec<(String, String)>,

    /// Raw report payloads are pruned after this many days (kept for
    /// schema-evolution replays + debugging). The derived `check` rows and the
    /// report summaries live far longer — see `report::retention`.
    pub raw_retention_days: i64,
    /// Per-check rows are pruned after this many days (a year of trends + margin).
    pub check_retention_days: i64,
}

fn env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_i64(key: &str, default: i64) -> Result<i64> {
    match std::env::var(key) {
        Ok(v) => v
            .parse()
            .with_context(|| format!("{key} must be an integer, got {v:?}")),
        Err(_) => Ok(default),
    }
}

/// Parse `PULSE_TOKENS` — a comma-separated list of `source:token` pairs, e.g.
/// `mac-mini:abc123,odin:def456`. Whitespace around entries is trimmed; empty
/// entries are ignored. A malformed entry (no colon, empty source/token) is a
/// hard error so a broken secret fails at boot, not silently at request time.
pub fn parse_tokens(raw: &str) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (source, token) = entry
            .split_once(':')
            .with_context(|| format!("PULSE_TOKENS entry {entry:?} is not source:token"))?;
        let source = source.trim();
        let token = token.trim();
        if source.is_empty() || token.is_empty() {
            anyhow::bail!("PULSE_TOKENS entry {entry:?} has an empty source or token");
        }
        out.push((source.to_string(), token.to_string()));
    }
    Ok(out)
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let tokens = parse_tokens(&env("PULSE_TOKENS")?)?;
        if tokens.is_empty() {
            anyhow::bail!("PULSE_TOKENS is empty — no producer could ever authenticate");
        }
        Ok(Self {
            database_url: env("DATABASE_URL")?,
            bind_addr: env_or("BIND_ADDR", "0.0.0.0:8080"),
            static_dir: std::env::var("STATIC_DIR").ok(),
            tokens,
            raw_retention_days: env_i64("PULSE_RAW_RETENTION_DAYS", 30)?,
            check_retention_days: env_i64("PULSE_CHECK_RETENTION_DAYS", 400)?,
        })
    }
}
