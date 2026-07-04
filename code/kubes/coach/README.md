# coach

Personal exercise/training tracker with an **adaptive pacing coach**. A sibling
of `life`: Rust (axum) backend + Angular 22 frontend + its own MariaDB, served
from one image and deployed to k3s on isis. Public at `coach.xinutec.org`, gated
by Nextcloud OAuth login.

Tracks a periodized program (weekly volume pool + optional day pins) across the
kit — rings on a 2 m bar, adjustable weights, a mat — and nudges you to spread
your sets through the day instead of cramming them at night. Reminders fire from
the Android app's on-device geofence (only when you're home).

## Layout

- `src/` — Rust backend (see module docs). `pacing/engine.rs` is the pure,
  unit-tested core; `pacing/service.rs` assembles its input + applies your tz.
- `migrations/` — sqlx migrations, run at boot. Append-only.
- `frontend/` — Angular app (Today burn-down, program editor, history, settings).
- `android/` — WebView wrapper + native geofence/notification layer (WIP).
- `k8s/` — namespace, PVC, MariaDB, app, ingress, DB network policy + deploy
  scripts.

## Develop

```sh
nix develop                 # cargo + node toolchain
./scripts/dev-db.sh         # local MariaDB on :3308 (db/user: coach/coach)
cp .env.example .env        # fill in; DEV_LOGIN_USER bypasses Nextcloud locally
cargo run                   # API on :8080 (STATIC_DIR unset = API only)
# frontend: cd frontend && npm install && npm start   # ng serve :4200, proxies /api

# to serve the built SPA from the backend (single origin):
#   (cd frontend && NG_BUILD_MAX_WORKERS=1 npm run build)   # the =1 avoids a macOS
#   STATIC_DIR=frontend/dist/coach-web/browser cargo run    # build-teardown abort
```

`gen-types.sh` regenerates the frontend TS types from the Rust API types;
`check-types.sh` is the drift gate. `verify.sh` runs the full fmt/clippy/build.

## Deploy

CI (`.github/workflows/build.yml`, on push to `main`) builds+pushes
`xinutec/coach:latest`. Then on isis (as root):

```sh
# one-time: NC OAuth2 client "coach" (dash admin), redirect
#   https://coach.xinutec.org/auth/callback
NC_CLIENT_ID=... NC_CLIENT_SECRET=... ./k8s/secret.sh
./k8s/sync.sh
```

DNS: `code/dns` CNAME `coach → isis.xinutec.org` (`tofu apply` from isis).
