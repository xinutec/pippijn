import * as crypto from "node:crypto";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.js";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { UserSession } from "../types.js";

interface SessionEntry extends UserSession {
  expiresAt: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = "session";

// In-memory session store. Acceptable for single-replica deployment.
const sessions = new Map<string, SessionEntry>();

export function createSession(secret: string, user: UserSession): string {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { ...user, expiresAt: Date.now() + SESSION_TTL_MS });
  return signValue(secret, id);
}

export function destroySession(secret: string, signedId: string): void {
  const id = verifyValue(secret, signedId);
  if (id) sessions.delete(id);
}

export function getSession(secret: string, signedId: string): UserSession | null {
  const id = verifyValue(secret, signedId);
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return { userId: entry.userId, displayName: entry.displayName };
}

export function signValue(secret: string, value: string): string {
  const sig = crypto.createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${sig}`;
}

export function verifyValue(secret: string, signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const sigBuf = Buffer.from(sig, "utf-8");
  const expectedBuf = Buffer.from(
    crypto.createHmac("sha256", secret).update(value).digest("base64url"),
    "utf-8"
  );
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  return value;
}

// Hono middleware: extracts session from cookie, sets c.get("session")
export function sessionMiddleware(secret: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const cookie = getCookie(c, COOKIE_NAME);
    if (cookie) {
      const session = getSession(secret, cookie);
      if (session) {
        c.set("session", session);
      }
    }
    await next();
  });
}

// Helper to set the session cookie on a Hono context
export function setSessionCookie(c: Context, signedId: string): void {
  setCookie(c, COOKIE_NAME, signedId, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context, secret: string): void {
  const cookie = getCookie(c, COOKIE_NAME);
  if (cookie) destroySession(secret, cookie);
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}
