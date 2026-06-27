# signal — Signal message archive

Archives Signal messages into MariaDB on the **isis** k3s cluster, the same way
`home`/`health` archive their data. Two feeds into one schema:

- **Ongoing** — [`signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api)
  links as a Signal **secondary device** and exposes received messages on a
  websocket; a small Rust **ingester** parses each frame into MariaDB.
- **History** (one-time, later) — an Android Signal backup decoded with
  [`signalbackup-tools`](https://github.com/bepaald/signalbackup-tools) and
  imported into the same tables.

```
                  one-time, on Mac
 Android Signal ──.backup──▶ signalbackup-tools ──▶ import script ─┐
   (history)                                                       │
                                                                   ▼
 Android Signal ──link (QR)──▶ signal-cli-rest-api ──ws──▶ ingester ──▶ MariaDB
   (ongoing)                   [json-rpc, PVC=keys]    (Rust)        [ns: signal]
```

Both feeds dedupe on `(sender_uuid, server_ts)` — a Signal timestamp is unique
per sender — so history and live overlap safely.

## Why signal-cli (not presage)
We first tried presage (all-Rust, in-process). Its secondary-device **linking
fails against current Signal servers with HTTP 409 / missing-capabilities**, even
on its latest commit. `signal-cli` (≥0.14.x, via the bbernhard REST image)
tracks Signal's required capabilities and links cleanly, so it owns the Signal
protocol; our Rust binary is reduced to a dumb, dependency-light websocket→DB
ingester (no libsignal/sqlcipher — fast, small build).

## Components
- `src/main.rs` — connects to `ws://signal-cli-rest-api:8080/v1/receive/<number>`,
  parses each JSON frame (defensively, via `serde_json::Value`), reconnects on drop.
- `src/db.rs` — MariaDB schema (append-only `MIGRATIONS`, run on startup) + inserts.
- `Dockerfile` — pure-Rust build (no C toolchain).
- `k8s/` — `00-namespace`, `01-pvc` (DB + signal-cli data), `02-db` (MariaDB),
  `03-signal-cli` (the rest-api engine), `04-ingester` (the Rust binary),
  `secret.sh` (DB creds; `SIGNAL_NUMBER` added after linking).

## Schema
`contacts`, `conversations` (`dm:<uuid>` / `group:<base64 groupId>`), `messages`
(UNIQUE `(sender_uuid, server_ts)`), `attachments`, `reactions`. Identities are
keyed on the Signal ACI UUID (E.164 number as fallback).

## Deploy (isis k3s, namespace `signal`)
1. Push to `main` → CI builds `xinutec/signal-archiver:latest` (the ingester).
2. `./k8s/secret.sh` (random DB creds; refuses to overwrite).
3. `kubectl apply -f k8s/00-namespace.yaml -f k8s/01-pvc.yaml -f k8s/02-db.yaml -f k8s/03-signal-cli.yaml`
4. **Link the device (your phone).** Fetch a QR PNG from the rest-api and scan it
   in **Signal → Settings → Linked devices → Link new device**:
   ```
   kubectl -n signal exec deploy/signal-cli-rest-api -- \
     curl -s 'http://localhost:8080/v1/qrcodelink?device_name=signal-archiver' -o /tmp/qr.png
   kubectl -n signal cp signal-cli-rest-api-<pod>:/tmp/qr.png ./qr.png   # then open/scan
   ```
   (The QR is a fresh, short-TTL provisioning link — scan promptly. signal-cli
   ≥0.14.x links without the 409.)
5. Discover the linked number and add it to the secret, then deploy the ingester:
   ```
   kubectl -n signal exec deploy/signal-cli-rest-api -- curl -s localhost:8080/v1/accounts
   kubectl -n signal patch secret signal-secret -p '{"stringData":{"SIGNAL_NUMBER":"+44..."}}'
   kubectl apply -f k8s/04-ingester.yaml
   ```
6. Verify: `kubectl -n signal exec deploy/signal-db -- mariadb -usignal -p signal -e 'SELECT COUNT(*) FROM messages;'`

## History backfill (later, one-time)
Android Signal → Chats → Backups (note the 30-digit passphrase) → copy the
`.backup` off the device → `signalbackup-tools` → import into the same tables
(dedupe makes it safe alongside the live feed). *(Import script TBD when we run this.)*

## v1 scope / known follow-ups
- Archives **incoming** text + quotes + attachment **metadata** + reactions, and
  **outgoing** messages (linked-device "Sent" sync).
- NOT yet: attachment **bytes** (the rest-api can fetch them via
  `GET /v1/attachments/<id>`), and group/contact **name** resolution (threads are
  keyed by id).

## Security
The signal-cli data PVC holds linked-device keys — secret-class; keep its odin
backup encrypted. The DB holds private conversations (same class as
`gchat-archive`); real content stays out of git.
