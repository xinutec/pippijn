import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { connect } from "./db/connection.js";
import { migrate } from "./db/schema.js";
import type { TokenPair } from "./fitbit/types.js";

const FITBIT_CLIENT_ID = process.env.FITBIT_CLIENT_ID ?? "";
const FITBIT_CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET ?? "";
const FITBIT_REDIRECT_URI = "https://health.xinutec.org/fitbit/auth";

const NC_CLIENT_ID = process.env.NC_CLIENT_ID ?? "";
const NC_CLIENT_SECRET = process.env.NC_CLIENT_SECRET ?? "";
const NC_BASE = "https://dash.xinutec.org";
const NC_REDIRECT_URI = "https://health.xinutec.org/auth/callback";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-secret";
const PORT = parseInt(process.env.AUTH_PORT ?? "3000", 10);

// In-memory session store (single pod, fine for this scale)
const sessions = new Map<string, { userId: string; displayName: string; expiresAt: number }>();

function createSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

function signCookie(value: string): string {
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
  return `${value}.${sig}`;
}

function verifyCookie(signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
  if (sig !== expected) return null;
  return value;
}

function getSessionFromReq(req: http.IncomingMessage): { userId: string; displayName: string } | null {
  const cookieHeader = req.headers.cookie ?? "";
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;
  const sessionId = verifyCookie(decodeURIComponent(match[1]));
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(sessionId);
    return null;
  }
  return session;
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Fitbit PKCE
const ALL_FITBIT_SCOPES = [
  "activity", "heartrate", "sleep", "weight", "nutrition", "profile",
  "oxygen_saturation", "respiratory_rate", "temperature", "cardio_fitness",
  "electrocardiogram", "location", "settings",
].join(" ");

let fitbitCodeVerifier = "";

function generateCodeVerifier(): string {
  return crypto.randomBytes(64).toString("base64url").slice(0, 128);
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// Serve static files from /app/public
function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  const publicDir = path.join(process.cwd(), "public");
  const filePath = urlPath === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, urlPath);

  // Prevent path traversal
  if (!filePath.startsWith(publicDir)) {
    return false;
  }

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const contentTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, { "Content-Type": contentTypes[ext] ?? "application/octet-stream" });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // --- Nextcloud SSO: login ---
  if (url.pathname === "/login") {
    const authUrl = new URL(`${NC_BASE}/index.php/apps/oauth2/authorize`);
    authUrl.searchParams.set("client_id", NC_CLIENT_ID);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", NC_REDIRECT_URI);
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  // --- Nextcloud SSO: callback ---
  if (url.pathname === "/auth/callback" && url.searchParams.has("code")) {
    const code = url.searchParams.get("code")!;

    const tokenRes = await fetch(`${NC_BASE}/index.php/apps/oauth2/api/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: NC_CLIENT_ID,
        client_secret: NC_CLIENT_SECRET,
        redirect_uri: NC_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Nextcloud auth failed: ${tokenRes.status}\n${body}`);
      return;
    }

    const tokenData = await tokenRes.json() as { access_token: string };

    // Get user info from Nextcloud
    const userRes = await fetch(`${NC_BASE}/ocs/v2.php/cloud/user?format=json`, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "OCS-APIRequest": "true",
      },
    });

    if (!userRes.ok) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to get user info from Nextcloud");
      return;
    }

    const userData = await userRes.json() as {
      ocs: { data: { id: string; displayname: string } };
    };

    const sessionId = createSessionId();
    sessions.set(sessionId, {
      userId: userData.ocs.data.id,
      displayName: userData.ocs.data.displayname,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `session=${encodeURIComponent(signCookie(sessionId))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    });
    res.end();
    return;
  }

  // --- Nextcloud SSO: logout ---
  if (url.pathname === "/logout") {
    const cookieHeader = req.headers.cookie ?? "";
    const match = cookieHeader.match(/session=([^;]+)/);
    if (match) {
      const sessionId = verifyCookie(decodeURIComponent(match[1]));
      if (sessionId) sessions.delete(sessionId);
    }
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": "session=; Path=/; HttpOnly; Secure; Max-Age=0",
    });
    res.end();
    return;
  }

  // --- API: current user ---
  if (url.pathname === "/api/me") {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, 401, { error: "not authenticated" });
      return;
    }
    jsonResponse(res, 200, session);
    return;
  }

  // --- API: data endpoints (all require auth) ---
  if (url.pathname.startsWith("/api/")) {
    const session = getSessionFromReq(req);
    if (!session) {
      jsonResponse(res, 401, { error: "not authenticated" });
      return;
    }

    const db = await connect();
    try {
      const days = parseInt(url.searchParams.get("days") ?? "30", 10);
      const since = new Date();
      since.setDate(since.getDate() - days);
      const sinceStr = since.toISOString().slice(0, 10);

      if (url.pathname === "/api/activity") {
        const rows = await db.query(
          "SELECT * FROM daily_activity WHERE date >= ? ORDER BY date", [sinceStr]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/sleep") {
        const rows = await db.query(
          "SELECT * FROM sleep WHERE date >= ? ORDER BY date", [sinceStr]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/heartrate/zones") {
        const rows = await db.query(
          "SELECT * FROM heart_rate_zones WHERE date >= ? ORDER BY date, zone_name", [sinceStr]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/heartrate/intraday") {
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        const rows = await db.query(
          "SELECT * FROM heart_rate_intraday WHERE ts >= ? AND ts < ? + INTERVAL 1 DAY ORDER BY ts",
          [date, date]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/body") {
        const rows = await db.query(
          "SELECT * FROM body WHERE date >= ? ORDER BY date", [sinceStr]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/spo2") {
        const rows = await db.query(
          "SELECT * FROM spo2_daily WHERE date >= ? ORDER BY date", [sinceStr]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/hrv") {
        const rows = await db.query(
          "SELECT * FROM hrv_daily WHERE date >= ? ORDER BY date", [sinceStr]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/breathing") {
        const rows = await db.query(
          "SELECT * FROM breathing_rate WHERE date >= ? ORDER BY date", [sinceStr]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/temperature") {
        const rows = await db.query(
          "SELECT * FROM skin_temperature WHERE date >= ? ORDER BY date", [sinceStr]
        );
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/devices") {
        const rows = await db.query("SELECT * FROM devices");
        jsonResponse(res, 200, rows);
      } else if (url.pathname === "/api/sync-state") {
        const rows = await db.query("SELECT * FROM sync_state");
        jsonResponse(res, 200, rows);
      } else {
        jsonResponse(res, 404, { error: "unknown endpoint" });
      }
    } finally {
      await db.end();
    }
    return;
  }

  // --- Fitbit OAuth (one-time setup) ---
  if (url.pathname === "/fitbit/auth" && !url.searchParams.has("code")) {
    const session = getSessionFromReq(req);
    if (!session) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }

    fitbitCodeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(fitbitCodeVerifier);

    const authUrl = new URL("https://www.fitbit.com/oauth2/authorize");
    authUrl.searchParams.set("client_id", FITBIT_CLIENT_ID);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", ALL_FITBIT_SCOPES);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("redirect_uri", FITBIT_REDIRECT_URI);

    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  if (url.pathname === "/fitbit/auth" && url.searchParams.has("code")) {
    const code = url.searchParams.get("code")!;
    const basicAuth = Buffer.from(`${FITBIT_CLIENT_ID}:${FITBIT_CLIENT_SECRET}`).toString("base64");

    const tokenRes = await fetch("https://api.fitbit.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: FITBIT_CLIENT_ID,
        code_verifier: fitbitCodeVerifier,
        redirect_uri: FITBIT_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Fitbit token exchange failed: ${tokenRes.status}\n${body}`);
      return;
    }

    const tokens: TokenPair = await tokenRes.json();
    const db = await connect();
    try {
      await migrate(db);
      await db.query(
        `INSERT INTO tokens (id, access_token, refresh_token, expires_at, scopes)
         VALUES (1, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           access_token = VALUES(access_token),
           refresh_token = VALUES(refresh_token),
           expires_at = VALUES(expires_at),
           scopes = VALUES(scopes)`,
        [tokens.access_token, tokens.refresh_token,
         new Date(Date.now() + tokens.expires_in * 1000), tokens.scope]
      );
    } finally {
      await db.end();
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Fitbit authorization successful</h1>
      <p>User ID: ${tokens.user_id}</p>
      <p>Scopes: ${tokens.scope}</p>
      <p><a href="/">Go to dashboard</a></p>`);
    return;
  }

  // --- Health check ---
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  // --- Static files (Angular app) ---
  if (serveStatic(res, url.pathname)) {
    return;
  }

  // SPA fallback: serve index.html for unmatched routes
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/fitbit/") && !url.pathname.startsWith("/auth/")) {
    if (serveStatic(res, "/")) return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found\n");
});

server.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});
