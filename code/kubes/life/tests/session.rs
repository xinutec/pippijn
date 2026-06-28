//! Session cookie signing/verification — the security-critical pure logic.

use life::session::{sign_value, verify_value};

const SECRET: &str = "test-secret";

#[test]
fn sign_then_verify_roundtrips() {
    let signed = sign_value(SECRET, "session-id-123");
    assert_eq!(
        verify_value(SECRET, &signed).as_deref(),
        Some("session-id-123")
    );
}

#[test]
fn verify_rejects_tampered_payload() {
    let signed = sign_value(SECRET, "session-id-123");
    // Flip the id but keep the original signature.
    let sig = signed.split_once('.').unwrap().1;
    let forged = format!("session-id-999.{sig}");
    assert_eq!(verify_value(SECRET, &forged), None);
}

#[test]
fn verify_rejects_wrong_secret() {
    let signed = sign_value(SECRET, "session-id-123");
    assert_eq!(verify_value("other-secret", &signed), None);
}

#[test]
fn verify_rejects_malformed() {
    assert_eq!(verify_value(SECRET, "no-dot-here"), None);
    assert_eq!(verify_value(SECRET, "id.not-hex"), None);
}
