# life

Personal home OS web app. Rust (axum) backend + Angular frontend, own MariaDB.
Nextcloud is used only for **identity** (login) and **calendar** (CalDAV) — see
[`docs/design/overview.md`](docs/design/overview.md).

## Develop

```sh
nix develop          # Rust toolchain + sqlx-cli
./scripts/dev-db.sh  # local MariaDB on 127.0.0.1:3307 (data in .dev/, gitignored)
cp .env.example .env # then fill values; DATABASE_URL points at the dev DB
cargo run            # boots, migrates, serves on $BIND_ADDR
```

`cargo test` runs offline. The DB integration test (`tests/db.rs`) runs only
when `LIFE_TEST_DATABASE_URL` is set, e.g.:

```sh
LIFE_TEST_DATABASE_URL=mysql://life:life@127.0.0.1:3307/life cargo test
```

## Frontend

Angular 22 (Material 3) in `frontend/`. One origin: dev proxies to the backend,
prod is served by the backend.

```sh
cd frontend && npm install
npm start            # ng serve on :4200, proxies /api,/login,... to :8080
npm run build        # → frontend/dist/life-web/browser
```

Serve the built bundle from the backend by pointing `STATIC_DIR` at it:

```sh
STATIC_DIR=frontend/dist/life-web/browser cargo run
```


### Required environment

| Var               | Meaning                                              |
|-------------------|------------------------------------------------------|
| `DATABASE_URL`    | `mysql://life:<pw>@<host>/life`                      |
| `SESSION_SECRET`  | random string; HMAC key for session cookies          |
| `NC_BASE_URL`     | Nextcloud base URL, no trailing slash                |
| `NC_CLIENT_ID`    | OAuth2 client id (registered in NC admin)            |
| `NC_CLIENT_SECRET`| OAuth2 client secret                                 |
| `NC_REDIRECT_URI` | must match the OAuth2 client's redirect URI          |
| `BIND_ADDR`       | optional, default `0.0.0.0:8080`                     |

See `.env.example`. The two NC client values come from **Settings → Security →
OAuth 2.0** in Nextcloud admin; the redirect URI must be
`<app-origin>/auth/callback`.

## Routes (current)

- `GET  /login` → redirect to NC for sign-in (identity only)
- `GET  /auth/callback` → completes login, sets session cookie
- `POST /logout`
- `GET  /api/me` → `{ userId, displayName, nextcloud }`
- `POST /api/nextcloud/connect/init` → start CalDAV app-password link
- `GET  /api/nextcloud/connect/status` → `active | needs_reauth | not_linked`
- `GET  /healthz`

Migrations in `migrations/` run automatically at boot.
