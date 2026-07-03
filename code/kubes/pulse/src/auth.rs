//! Ingest authentication: map a bearer token to the source it may write as.
//!
//! Reads are unauthenticated (the VPN + ingress source-range whitelist is the
//! gate). Only POST /api/reports needs a token, and the token *is* the identity:
//! a producer can only write reports attributed to its own configured `source`,
//! so a buggy or compromised producer can never spoof another machine's status.

use axum::http::HeaderMap;

/// Constant-time byte comparison — avoids leaking token length/prefix via timing.
/// Returns false immediately on a length mismatch (length is not secret here;
/// tokens are fixed-width random) but compares all bytes otherwise.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extract the `Authorization: Bearer <token>` value, if present and well-formed.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let token = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))?;
    let token = token.trim();
    if token.is_empty() { None } else { Some(token) }
}

/// Resolve the request's bearer token to a source name, or None if it matches no
/// configured producer. `tokens` is the `(source, token)` list from config.
pub fn authenticate(headers: &HeaderMap, tokens: &[(String, String)]) -> Option<String> {
    let presented = bearer(headers)?;
    // Compare against every token (constant-time each) rather than short-circuit
    // on first char, so a caller can't probe which source a prefix belongs to.
    let mut matched: Option<String> = None;
    for (source, token) in tokens {
        if ct_eq(presented.as_bytes(), token.as_bytes()) {
            matched = Some(source.clone());
        }
    }
    matched
}
