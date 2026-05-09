import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AppEnv } from "../env.js";
import type { UserSession } from "../types.js";
import { createState, consumeState } from "../middleware/oauth-state.js";
import { createSession, setSessionCookie, clearSessionCookie } from "../middleware/session.js";

const ncTokenSchema = z.object({ access_token: z.string().min(1) });
const ncUserSchema = z.object({
  ocs: z.object({
    data: z.object({
      id: z.string().min(1),
      displayname: z.string(),
    }),
  }),
});

export function nextcloudOAuthRoutes(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const nc = config.nextcloud;

  app.get("/login", (c) => {
    const state = createState();
    const url = new URL(`${nc.baseUrl}/index.php/apps/oauth2/authorize`);
    url.searchParams.set("client_id", nc.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", nc.redirectUri);
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.get("/auth/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const pending = consumeState(state);
    if (!pending) {
      return c.text("Invalid or expired OAuth state. Please try logging in again.", 403);
    }

    const code = c.req.query("code");
    if (!code) {
      return c.text("Missing authorization code.", 400);
    }

    const tokenRes = await fetch(`${nc.baseUrl}/index.php/apps/oauth2/api/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: nc.clientId,
        client_secret: nc.clientSecret,
        redirect_uri: nc.redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      console.error(`Nextcloud token exchange failed: ${tokenRes.status}`, await tokenRes.text());
      return c.text("Authentication failed. Please try again.", 500);
    }

    const { access_token } = ncTokenSchema.parse(await tokenRes.json());

    const userRes = await fetch(`${nc.baseUrl}/ocs/v2.php/cloud/user?format=json`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "OCS-APIRequest": "true",
      },
    });

    if (!userRes.ok) {
      console.error(`Nextcloud user info failed: ${userRes.status}`, await userRes.text());
      return c.text("Authentication failed. Please try again.", 500);
    }

    const userData = ncUserSchema.parse(await userRes.json());

    const user: UserSession = {
      userId: userData.ocs.data.id,
      displayName: userData.ocs.data.displayname,
    };

    const signedId = await createSession(config.sessionSecret, user);
    setSessionCookie(c, signedId);
    return c.redirect("/");
  });

  app.post("/logout", async (c) => {
    await clearSessionCookie(c, config.sessionSecret);
    return c.redirect("/");
  });

  return app;
}
