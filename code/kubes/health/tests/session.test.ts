import { describe, it, expect } from "vitest";
import { signValue, verifyValue, createSession, getSession, destroySession } from "../src/middleware/session.js";

const SECRET = "test-secret-at-least-16-chars";

describe("signValue / verifyValue", () => {
  it("round-trips a value", () => {
    const signed = signValue(SECRET, "hello");
    expect(verifyValue(SECRET, signed)).toBe("hello");
  });

  it("rejects tampered value", () => {
    const signed = signValue(SECRET, "hello");
    const tampered = "tampered" + signed.slice(5);
    expect(verifyValue(SECRET, tampered)).toBeNull();
  });

  it("rejects tampered signature", () => {
    const signed = signValue(SECRET, "hello");
    const tampered = signed.slice(0, -3) + "xxx";
    expect(verifyValue(SECRET, tampered)).toBeNull();
  });

  it("rejects wrong secret", () => {
    const signed = signValue(SECRET, "hello");
    expect(verifyValue("wrong-secret-also-long", signed)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(verifyValue(SECRET, "")).toBeNull();
  });

  it("rejects string without dot", () => {
    expect(verifyValue(SECRET, "nodot")).toBeNull();
  });

  it("rejects signature with wrong length (no crash)", () => {
    // This would crash timingSafeEqual without the length check
    expect(verifyValue(SECRET, "value.short")).toBeNull();
    expect(verifyValue(SECRET, "value.")).toBeNull();
    expect(verifyValue(SECRET, "value." + "a".repeat(200))).toBeNull();
  });
});

describe("session lifecycle", () => {
  it("creates and retrieves a session", () => {
    const signed = createSession(SECRET, { userId: "alice", displayName: "Alice" });
    const session = getSession(SECRET, signed);
    expect(session).toEqual({ userId: "alice", displayName: "Alice" });
  });

  it("returns null for unknown session", () => {
    const signed = signValue(SECRET, "nonexistent-id");
    expect(getSession(SECRET, signed)).toBeNull();
  });

  it("destroys a session", () => {
    const signed = createSession(SECRET, { userId: "bob", displayName: "Bob" });
    expect(getSession(SECRET, signed)).not.toBeNull();
    destroySession(SECRET, signed);
    expect(getSession(SECRET, signed)).toBeNull();
  });

  it("handles destroy of nonexistent session gracefully", () => {
    const signed = signValue(SECRET, "does-not-exist");
    expect(() => destroySession(SECRET, signed)).not.toThrow();
  });
});
