# Google Health API migration (Fitbit Web API sunset)

Status: **weight slice shipped; full migration + durable auth deferred** (decision 2026-06-19).
Tracking: task #260.

## Why

Google is turning down the **legacy Fitbit Web API** (`api.fitbit.com`) in
**September 2026** and replacing it with the **Google Health API**
(`health.googleapis.com`). health-sync authenticates against the legacy API
(`FitbitClient` + Fitbit OAuth), so the whole Fitbit ingestion path must move
to Google OAuth + the Google Health API before that date or it goes dark.

This already bit one metric early: **weight**. The body scale (Hume) writes
via **Health Connect → Google Health**, which the legacy Fitbit Web API never
receives. So the Fitbit weight feed froze (forward-filled) in Apr 2026 when
that path switched, while the real weigh-ins only existed on the Google side.

## What's done — weight slice (shipped)

- `src/google/oauth.ts` — refresh-token → access-token (Google OAuth 2.0).
- `src/google/health.ts` — Google Health v4 client; paginates
  `GET https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints`.
- `src/google/body.ts` — maps weigh-ins → `body` table. Google returns real,
  individually-timestamped measurements (integer grams + sample time), not a
  forward-filled daily series, so for the covered window we **replace** the
  stale Fitbit rows with the real values.
- `src/cli/sync-google-weight.ts` — dry-run by default; `--apply` writes.
- `scripts/ghealth-spike.mjs` — one-time PKCE loopback OAuth to mint a refresh
  token (and a quick read of weight data points).
- Backfilled the real weigh-in history; the Trends weight chart now shows the
  true series instead of the frozen value.

### Key facts (so we don't re-research)

- Google Health API is a **cloud REST API** — a backend with a stored refresh
  token polls it server-to-server, no phone needed (distinct from on-device
  Health Connect).
- Unified data model: `users/me/dataTypes/{type}/dataPoints` for every metric.
- OAuth: `accounts.google.com/o/oauth2/v2/auth` + `oauth2.googleapis.com/token`,
  PKCE, `access_type=offline`.
- Scope for body metrics:
  `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
  (sleep / activity / ecg have their own `googlehealth.*.readonly` scopes).
- Google Cloud project **"Xinutec Health"**; Desktop OAuth client
  `553831388950-3cf4rqrg01fh62u34rslas43tj6ek2t9.apps.googleusercontent.com`.
- Client **secret** and **refresh token** live only in env / a secret — never
  in the repo.
- Restricted-scope verification is **not** needed for personal use (≤100 test
  users); the spike confirmed the scope authorizes in Testing mode.

## Durability — DEFERRED (use the 7-day token until it breaks)

The OAuth app is in **Testing** publishing status, where Google **revokes
refresh tokens after 7 days**. So headless sync stops roughly weekly until
re-auth.

**Decision (2026-06-19): do not productionize yet.** Use the 7-day token; when
it expires and weight stops updating, either re-auth manually (below) or, if it
becomes annoying, do the one-time permanent fix. Don't build a cron that would
silently rot in 7 days.

### Permanent fix (when we want it) — free, no verification

1. OAuth consent screen → **Publish app** (Testing → In production), at
   `console.cloud.google.com/auth/audience`. Free; **no CASA verification**
   needed for personal use — you just click through a one-time "unverified app"
   warning at consent. In-production refresh tokens **persist long-term**, like
   the old Fitbit token did.
2. Re-auth once to mint a long-lived refresh token.
3. Store `GH_CLIENT_ID` / `GH_CLIENT_SECRET` / `GH_REFRESH_TOKEN` as a k8s
   secret; add a daily CronJob running `sync-google-weight --apply`.

The paid **CASA** security assessment ($500–$4,500+/yr, recurring) is **only**
for removing the warning / going multi-user public — irrelevant here.

### How to re-auth manually (when the 7-day token expires)

```
cd ~/Code/pippijn/code/kubes/health
GH_CLIENT_ID=<id> GH_CLIENT_SECRET=<secret> \
  nix-shell -p nodejs_22 --run 'node scripts/ghealth-spike.mjs'
# approve in a browser ON THIS MACHINE (loopback 127.0.0.1:8765); copy the
# printed refresh token, then:
GH_CLIENT_ID=<id> GH_CLIENT_SECRET=<secret> GH_REFRESH_TOKEN=<token> \
  ./scripts/prod-db.sh node dist/cli/sync-google-weight.js pippijn --apply
```

(If consent happens on a different device, the loopback redirect won't reach
this machine — paste the redirect URL's `code` and curl it to the still-running
listener on `127.0.0.1:8765`.)

## Remaining (before Sep 2026)

Migrate the other metrics onto the same v4 `dataPoints` model + a proper Google
OAuth token-manager in the app, then retire the Fitbit Web API:
heart rate (incl. intraday), sleep, steps/activity, HRV, SpO2, respiratory
rate, temperature. Each is `users/me/dataTypes/{type}/dataPoints` under the
matching `googlehealth.*.readonly` scope.
