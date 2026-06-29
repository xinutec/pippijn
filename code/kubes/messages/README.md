# messages — Signal + Google Chat archive viewer

A read-only web UI for the message archive stored in the **`signal` MariaDB** on
the isis k3s cluster — both origins ([Signal](../signal) live + history, and the
imported Google Chat tables). Same per-service pattern as `life`/`health`.

```
 Browser ──VPN/login──▶ messages.xinutec.org (isis, ns: signal)
                            │  Rust/axum: Nextcloud OAuth2 (identity) + sessions
                            │  + read-only API over the archive
                            ▼
                        signal MariaDB  ─ messages / conversations / reactions   (Signal)
                                        └ gchat_messages / gchat_conversations…   (Google Chat)
```

## Security model
Three layers, strongest first:
1. **Nextcloud login + allow-list (the real gate).** OAuth2 identity-only against
   `dash.xinutec.org` (copied from `life`). A successfully-authenticated user is
   still rejected (403) unless their NC id is in `ALLOWED_USERS` (currently
   `pippijn`). This holds regardless of network path.
2. **VPN-only by DNS.** `messages.xinutec.org` → `10.100.0.2` (isis's WireGuard
   IP), so it isn't listed on the public internet. NB this is *obscurity*: the
   isis ingress also answers on the public IP, so DNS alone doesn't firewall it
   — hence the login carries the security.
3. *(optional, not enabled)* L7 source-range allow-list. Add
   `nginx.ingress.kubernetes.io/whitelist-source-range: "10.100.0.0/24"` to the
   ingress for true VPN-only — but first confirm client source IPs survive k3s
   servicelb (klipper may SNAT them).

## Components
- `src/` — Rust/axum backend. `nextcloud/identity.rs` + `session.rs` are the
  `life` auth pattern verbatim; `routes/auth.rs` adds the allow-list check;
  `archive.rs` is the read-only, origin-normalising query layer; `config.rs`
  builds the DB DSN from `DB_*` so it reuses `signal-secret` in-namespace. The
  only table this app owns is `sessions` (created on boot, `src/db.rs`).
- `frontend/` — Angular (login gate → conversation list with origin filter →
  thread view with reactions / edited / deleted markers).
- `k8s/` — `00-letsencrypt-dns-issuer.yaml` (one-time isis setup), `01-app.yaml`
  (Deployment+Service in the `signal` namespace), `02-ingress.yaml`, `secret.sh`.
- `Dockerfile` — multi-stage (Angular + Rust → one image), `xinutec/messages:latest`.

## API (all require a valid session)
- `GET /api/me` — current user.
- `GET /api/conversations` — both origins, each tagged `origin`, newest first.
- `GET /api/conversations/{origin}/{id}/messages?before=<ms>&limit=` — one page,
  oldest→newest, reactions attached; `before` pages backwards.
- `GET /api/search?q=` — substring search across both origins.

`{origin}` is `signal` or `gchat`; `{id}` is the Signal `thread_id` or the gchat
`group_id`.

## Local dev
```
# backend (needs the DB; tunnel signal-db or point at a local MariaDB)
DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=signal DB_USER=… DB_PASSWORD=… \
NC_BASE_URL=https://dash.xinutec.org NC_CLIENT_ID=… NC_CLIENT_SECRET=… \
NC_REDIRECT_URI=http://localhost:4200/auth/callback \
SESSION_SECRET=$(openssl rand -hex 32) ALLOWED_USERS=pippijn \
  cargo run
# frontend (proxies /api,/login,/auth,/logout to :8080)
cd frontend && npm ci && npm start    # http://localhost:4200
```

## Deploy (isis, namespace `signal`)
Most steps are one-time. Steps 1–3 need actions only you can do.

1. **Register the OAuth2 client** in Nextcloud admin (dash.xinutec.org → Settings
   → Security → OAuth 2.0), redirect URI `https://messages.xinutec.org/auth/callback`.
   Note the client id + secret.
2. **DNS-01 issuer on isis** (once per cluster — isis only has HTTP-01 today):
   ```
   kubectl -n cert-manager create secret generic cloudflare-api-token \
     --from-literal=api-token=<Cloudflare Zone:DNS:Edit token>   # if absent
   kubectl apply -f k8s/00-letsencrypt-dns-issuer.yaml
   ```
3. **DNS record:** `code/dns` already defines `messages → 10.100.0.2`; apply it:
   `cd code/dns && terraform apply`.
4. **App secret** (session key + OAuth client; DB creds come from `signal-secret`):
   `NC_CLIENT_ID=… NC_CLIENT_SECRET=… ./k8s/secret.sh`.
5. **Push to main** → CI builds `xinutec/messages:latest` (gated on clippy + tests).
6. **Deploy:** `kubectl apply -f k8s/01-app.yaml -f k8s/02-ingress.yaml`, then
   `kubectl -n signal rollout status deploy/messages` and check the cert:
   `kubectl -n signal get certificate messages-tls`.

## Status
Thin vertical slice: login (+ allow-list) → conversation list (both origins) →
thread view + search. Not yet: message pagination UI (the API supports `before`),
richer Signal edit-history rendering, attachment display. The `archive.rs`
reaction aggregation for Signal approximates live state as distinct non-removed
authors per emoji (ignores same-author add-then-remove within a page).
