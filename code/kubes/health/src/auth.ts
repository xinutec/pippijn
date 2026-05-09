import * as http from "node:http";
import * as crypto from "node:crypto";
import { connect } from "./db/connection.js";
import { migrate } from "./db/schema.js";
import type { TokenPair } from "./fitbit/types.js";

const CLIENT_ID = process.env.FITBIT_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.FITBIT_REDIRECT_URI ?? "https://health.xinutec.org/auth";
const PORT = parseInt(process.env.AUTH_PORT ?? "3000", 10);

const ALL_SCOPES = [
  "activity",
  "heartrate",
  "sleep",
  "weight",
  "nutrition",
  "profile",
  "oxygen_saturation",
  "respiratory_rate",
  "temperature",
  "cardio_fitness",
  "electrocardiogram",
  "location",
  "settings",
].join(" ");

// PKCE helpers
function generateCodeVerifier(): string {
  return crypto.randomBytes(64).toString("base64url").slice(0, 128);
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

let codeVerifier = "";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/auth" && !url.searchParams.has("code")) {
    // Step 1: Redirect to Fitbit authorization
    codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const authUrl = new URL("https://www.fitbit.com/oauth2/authorize");
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", ALL_SCOPES);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);

    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  if (url.pathname === "/auth" && url.searchParams.has("code")) {
    // Step 2: Exchange code for tokens
    const code = url.searchParams.get("code")!;

    const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
      "base64"
    );

    const tokenRes = await fetch("https://api.fitbit.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Token exchange failed: ${tokenRes.status}\n${body}`);
      return;
    }

    const tokens: TokenPair = await tokenRes.json();

    // Store tokens in DB
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
        [
          tokens.access_token,
          tokens.refresh_token,
          new Date(Date.now() + tokens.expires_in * 1000),
          tokens.scope,
        ]
      );
    } finally {
      await db.end();
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<h1>Authorization successful</h1>
       <p>Tokens stored. User ID: ${tokens.user_id}</p>
       <p>Scopes granted: ${tokens.scope}</p>
       <p>You can close this page.</p>`
    );
    return;
  }

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("health-sync auth server ok\n");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found\n");
});

server.listen(PORT, () => {
  console.log(`Auth server listening on port ${PORT}`);
  console.log(`Visit https://health.xinutec.org/auth to authorize`);
});
