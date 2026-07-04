//! Runtime configuration, read from the environment at startup.
//!
//! Secrets (session secret, NC OAuth client) come from the environment so
//! they can be supplied as k8s secrets in deployment and a `.env`-style shell
//! locally. Nothing here is hard-coded.

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct Config {
    /// MariaDB connection string, e.g. `mysql://coach:pw@host/coach`.
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

    /// Directory of the built Angular bundle to serve (with SPA fallback). When
    /// unset the server is API-only — e.g. in dev, where `ng serve` proxies.
    pub static_dir: Option<String>,

    /// DEV ONLY. When set, `/dev-login` mints a session for this user id
    /// without Nextcloud. Absent in production → the route 404s. Never set this
    /// in a deployed environment.
    pub dev_login_user: Option<String>,
}

fn env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let nc_base_url = env("NC_BASE_URL")?.trim_end_matches('/').to_string();
        // Fail fast at boot rather than panicking inside the /login handler at
        // request time: identity::authorize_url parses this as a base URL.
        let parsed = url::Url::parse(&nc_base_url)
            .with_context(|| format!("NC_BASE_URL is not a valid URL: {nc_base_url:?}"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host().is_none() {
            anyhow::bail!("NC_BASE_URL must be an http(s) URL with a host: {nc_base_url:?}");
        }
        Ok(Self {
            database_url: env("DATABASE_URL")?,
            session_secret: env("SESSION_SECRET")?,
            bind_addr: env_or("BIND_ADDR", "0.0.0.0:8080"),
            nc_base_url,
            nc_client_id: env("NC_CLIENT_ID")?,
            nc_client_secret: env("NC_CLIENT_SECRET")?,
            nc_redirect_uri: env("NC_REDIRECT_URI")?,
            static_dir: std::env::var("STATIC_DIR").ok(),
            dev_login_user: std::env::var("DEV_LOGIN_USER").ok(),
        })
    }
}
