//! Runtime configuration from the environment.
//!
//! The DB connection is assembled from parts (DB_HOST/…), matching the signal
//! ingester's convention, so this app can read the very same `signal-secret`
//! (DB_USER/DB_PASSWORD) in-namespace rather than duplicating a DSN.

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct Config {
    /// MariaDB connection string, assembled from DB_* parts.
    pub database_url: String,
    /// HMAC key for signing session cookies.
    pub session_secret: String,
    /// Address to bind the HTTP server to.
    pub bind_addr: String,

    /// Base URL of the Nextcloud instance, no trailing slash.
    pub nc_base_url: String,
    /// OAuth2 client registered in NC admin (identity flow).
    pub nc_client_id: String,
    pub nc_client_secret: String,
    /// Must match the redirect URI registered for the OAuth2 client.
    pub nc_redirect_uri: String,

    /// Nextcloud user ids permitted to log in. The archive holds private
    /// messages and the host is on a shared VPN, so access is fail-closed: an
    /// empty list (or a user not on it) is rejected. Set via ALLOWED_USERS
    /// (comma-separated).
    pub allowed_users: Vec<String>,

    /// Directory of the built Angular bundle to serve (SPA fallback). Unset →
    /// API-only (dev, where `ng serve` proxies).
    pub static_dir: Option<String>,
}

fn env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let db_host = env("DB_HOST")?;
        let db_port = env_or("DB_PORT", "3306");
        let db_name = env("DB_NAME")?;
        let db_user = env("DB_USER")?;
        let db_password = env("DB_PASSWORD")?;
        let database_url =
            format!("mysql://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}");

        let allowed_users = env("ALLOWED_USERS")?
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();

        Ok(Self {
            database_url,
            session_secret: env("SESSION_SECRET")?,
            bind_addr: env_or("BIND_ADDR", "0.0.0.0:8080"),
            nc_base_url: env("NC_BASE_URL")?.trim_end_matches('/').to_string(),
            nc_client_id: env("NC_CLIENT_ID")?,
            nc_client_secret: env("NC_CLIENT_SECRET")?,
            nc_redirect_uri: env("NC_REDIRECT_URI")?,
            allowed_users,
            static_dir: std::env::var("STATIC_DIR").ok(),
        })
    }

    /// Whether a Nextcloud user id is permitted to use the app.
    pub fn is_allowed(&self, user_id: &str) -> bool {
        self.allowed_users.iter().any(|u| u == user_id)
    }
}
