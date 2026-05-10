# health-sync — Design

Health data aggregation and visualization service. Syncs Fitbit data into
MariaDB on isis, accessible via a web dashboard authenticated through
Nextcloud SSO.

## Architecture

```
                          ┌──────────────┐
                          │  Fitbit API  │
                          └──────┬───────┘
                                 │ OAuth2 + REST
                                 ▼
┌─────────┐  Nextcloud   ┌──────────────┐  SQL   ┌───────────┐
│ Browser  │◄────SSO────►│  health-sync │◄──────►│ MariaDB   │
│ (Angular)│   session    │  (Hono)      │  pool  │ (per-user │
└─────────┘              └──────────────┘        │  tables)  │
                                 ▲                └───────────┘
                                 │
                          ┌──────┴───────┐
                          │  CronJob     │
                          │  (hourly)    │
                          └──────────────┘
```

## Components

### Backend (`src/`)

TypeScript on Hono (lightweight HTTP framework). Two entry points:

- **`server.ts`** — HTTP server for the dashboard and OAuth flows.
  Serves the Angular SPA, API endpoints, and handles Nextcloud SSO +
  Fitbit OAuth.
- **`sync.ts`** — CronJob entry point. Iterates over all users with
  linked Fitbit accounts and syncs their data.

### Frontend (`frontend/`)

Angular 19 SPA. Standalone components, signals, Chart.js for
visualization. Built to static files, served by the backend from
`public/`.

### Infrastructure (`k8s/`)

Deployed on isis's k3s cluster in the `health` namespace:
- MariaDB 11.8 (Deployment + headless Service + PVC)
- health-auth (Deployment + Service running `server.ts`)
- health-sync (CronJob running `sync.ts` hourly)
- Ingress with cert-manager TLS at `health.xinutec.org`

Docker image built by GitHub Actions, pushed to `xinutec/health-sync`
on Docker Hub.

## Authentication

Two OAuth2 flows:

1. **Nextcloud SSO** — users log in via Nextcloud (`dash.xinutec.org`).
   The callback creates a signed, HttpOnly session cookie. All API
   endpoints require a valid session.

2. **Fitbit linking** — authenticated users link their Fitbit account
   via `/fitbit/auth`. Tokens are stored in MariaDB keyed by the
   Nextcloud user ID.

Both flows use CSRF-protected `state` parameters stored in a
time-limited pending map (10 minute expiry). Fitbit's flow also uses
PKCE (S256 code challenge).

## Multi-user data model

Every data table includes `user_id` as part of the primary key.
API queries filter by the session's user ID — users can only see their
own data. The sync job iterates over all users in the `tokens` table.

## Module structure

```
src/
├── server.ts               # Hono app + HTTP server
├── sync.ts                 # CronJob: sync all users
├── config.ts               # Validated env config (zod)
├── types.ts                # Shared types (DB rows, API responses)
├── db/
│   ├── pool.ts             # MariaDB connection pool (singleton)
│   └── schema.ts           # Numbered migrations, tracked in schema_migrations table
├── middleware/
│   ├── session.ts          # Session store, cookie signing, middleware
│   └── auth.ts             # requireAuth middleware
├── routes/
│   ├── api.ts              # /api/* data endpoints
│   ├── nextcloud-oauth.ts  # /login, /auth/callback, /logout
│   └── fitbit-oauth.ts     # /fitbit/auth, /fitbit/auth?code=...
└── fitbit/
    ├── client.ts           # HTTP client with rate limiting + refresh
    └── sync/
        ├── activity.ts
        ├── sleep.ts
        ├── heartrate.ts
        ├── body.ts
        ├── spo2.ts
        ├── hrv.ts
        ├── breathing.ts
        ├── temperature.ts
        └── devices.ts
```

## Testing

Vitest. Tests cover:
- Session signing and verification
- OAuth state lifecycle (create, consume, expiry, replay)
- API user isolation (queries only return data for the session user)
- Config validation

## Security checklist

- [x] Session cookies: HttpOnly, Secure, SameSite=Lax, HMAC-signed
- [x] Sessions are in-memory (lost on pod restart — users re-login via Nextcloud SSO, no data lost)
- [x] CSRF: state parameter on both OAuth flows, validated on callback
- [x] PKCE: Fitbit OAuth uses S256 code challenge
- [x] User isolation: all DB queries filtered by session user_id
- [x] No credentials in Docker image or git (git-crypt for secret.sh)
- [x] Input validation: query parameters validated with zod
- [x] Connection pool: no per-request connect/disconnect
- [ ] Rate limiting on login endpoint (future)
- [ ] CSP headers (future)

## Schema evolution

Migrations are numbered SQL statements in `src/db/schema.ts`. A
`schema_migrations` table tracks which have been applied. To change the
schema, append a new migration — never modify or remove existing ones.
This means data is never dropped during deployment.

## Data ownership / what we store

Default rule: **maximal normalisation**. Every fact has exactly one
storage location; nothing else mirrors, copies, or pre-aggregates it.
Two copies of the same fact eventually drift apart, and keeping them
in sync is its own bug surface. We accept slower queries (joins, live
re-fetches, on-the-fly aggregation) to avoid that class of problem.

Three deliberate exceptions, each justified:

- **Mirror third-party data we don't own.** Fitbit health metrics (HR,
  sleep, activity, ...) — Fitbit may sunset, accounts may close,
  history disappears. Without our own copy we lose access. So we sync
  Fitbit into MariaDB and treat *our* tables as the source of truth
  henceforth.
- **Cache external API responses we don't own** when the upstream is
  rate-limited or slow. `osm_cache` mirrors Nominatim/Overpass results;
  the cache is a courtesy to them, not duplication of ours. Cached
  results are pure functions of inputs (lat/lon), so drift is impossible.
- **Persist algorithmic outputs, not their inputs.** `focus_places` is
  the result of running the focus-places pipeline over the user's
  PhoneTrack history; it's a computed cache that's cheap to refresh
  (re-fetch + recompute weekly) and avoids a slow recompute on every
  dashboard load. Crucially, we **don't** persist the raw GPS history
  itself — that lives in Nextcloud (PhoneTrack), which we own. When
  the algorithm runs, it re-fetches.

What we explicitly do **not** do:

- Mirror PhoneTrack history into the health DB.
- Pre-aggregate summary tables (e.g. "weekly_step_total") that can be
  computed at query time from the underlying intraday data.
- Store derivable values alongside the inputs they're derived from.
- Cache anything from a system we already control unless there's a
  measured performance problem.

When a join across "kept" sources (e.g. Fitbit HR × PhoneTrack
location) is needed, fetch both into memory and join in code. At our
scale (single-digit users, MBs of data per quarter per user) this is
fast enough.

## Future extensions

- PhoneTrack location data via Nextcloud API
- Correlation analysis (health metrics × location/travel)
- Google Health API migration (Fitbit API deprecated September 2026)
