//! Auth routes: Nextcloud identity login (OAuth2) + a dev-only bypass.

use anyhow::anyhow;
use axum::extract::{Query, State};
use axum::response::Redirect;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::Deserialize;

use crate::error::AppError;
use crate::nextcloud::identity;
use crate::session::{COOKIE_NAME, UserSession, create_session, destroy_session};
use crate::state::AppState;

fn session_cookie(value: String) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, value))
        .path("/")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(7))
        .build()
}

/// Only allow same-site internal paths as a post-login redirect target.
/// Rejects `//host` (protocol-relative) and `/\host` — browsers fold `\` to
/// `/` in special-scheme URLs, so a Location of `/\evil.com` would redirect
/// off-site.
pub fn validate_return_to(return_to: Option<&str>) -> String {
    match return_to {
        Some(p) if p.starts_with('/') && !p[1..].starts_with(['/', '\\']) => p.to_string(),
        _ => "/".to_string(),
    }
}

#[derive(Deserialize)]
pub struct LoginQuery {
    return_to: Option<String>,
}

/// GET /login → redirect to NC's OAuth2 authorize endpoint.
pub async fn login(State(app): State<AppState>, Query(q): Query<LoginQuery>) -> Redirect {
    let state = app.create_oauth_state(q.return_to);
    Redirect::to(&identity::authorize_url(&app.cfg, &state))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

/// GET /auth/callback → exchange code, read identity, create our session.
pub async fn callback(
    State(app): State<AppState>,
    jar: CookieJar,
    Query(q): Query<CallbackQuery>,
) -> Result<(CookieJar, Redirect), AppError> {
    let state = q.state.unwrap_or_default();
    let pending = app
        .consume_oauth_state(&state)
        .ok_or(AppError::Unauthorized)?;
    let code = q
        .code
        .ok_or_else(|| anyhow!("missing authorization code"))?;

    let token = identity::exchange_code(&app.http, &app.cfg, &code).await?;
    let nc_user = identity::fetch_user(&app.http, &app.cfg, &token).await?;

    let user = UserSession {
        user_id: nc_user.id,
        display_name: nc_user.display_name,
    };
    let signed = create_session(&app.pool, &app.cfg.session_secret, &user).await?;
    let dest = validate_return_to(pending.return_to.as_deref());
    Ok((jar.add(session_cookie(signed)), Redirect::to(&dest)))
}

/// POST /logout → destroy the session + clear the cookie.
pub async fn logout(
    State(app): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Redirect), AppError> {
    if let Some(c) = jar.get(COOKIE_NAME) {
        destroy_session(&app.pool, &app.cfg.session_secret, c.value()).await?;
    }
    Ok((jar.remove(Cookie::from(COOKIE_NAME)), Redirect::to("/")))
}

/// GET /dev-login → DEV ONLY. Mints a session for `DEV_LOGIN_USER` with no
/// Nextcloud. The route is only mounted when that env var is set (see
/// routes::router); this handler also re-checks, so it 404s otherwise.
pub async fn dev_login(
    State(app): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Redirect), AppError> {
    let user_id = app.cfg.dev_login_user.clone().ok_or(AppError::NotFound)?;
    let user = UserSession {
        display_name: user_id.clone(),
        user_id,
    };
    let signed = create_session(&app.pool, &app.cfg.session_secret, &user).await?;
    Ok((jar.add(session_cookie(signed)), Redirect::to("/")))
}
