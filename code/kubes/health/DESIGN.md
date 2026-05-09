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

## Future extensions

- PhoneTrack location data via Nextcloud API
- Correlation analysis (health metrics × location/travel)
- Google Health API migration (Fitbit API deprecated September 2026)
