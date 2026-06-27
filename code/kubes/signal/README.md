# signal — Signal message archive

Archives Signal messages into MariaDB on the **isis** k3s cluster, the same way
`home`/`health` archive their data. Two feeds into one schema:

- **Ongoing** — a small Rust binary ([presage](https://github.com/whisperfish/presage))
  links as a Signal **secondary device** and streams every received message into
  MariaDB. No JVM, no `signal-cli`.
- **History** (one-time, later) — an Android Signal backup decoded with
  [`signalbackup-tools`](https://github.com/bepaald/signalbackup-tools) and
  imported into the same tables.

```
Android Signal ──link (QR)──▶ signal-archiver ──▶ MariaDB (ns: signal)
   (ongoing)        once       [presage, PVC=keys]      │
Android .backup ──signalbackup-tools──▶ import script ──┘  (history, one-time)
```

Both feeds dedupe on `(sender_uuid, server_ts)` — a Signal message timestamp is
unique per sender — so history and live overlap safely.

## Why presage / Rust
One self-contained binary is *both* the Signal client and the DB writer (no
`signal-cli` JVM, no REST shim). Trade-off: presage is a community library that
tracks the Signal protocol, so it's pinned to a specific **main commit** in
`Cargo.toml` — a future `cargo update` can't silently pull a breaking API. Bump
deliberately. (The 0.7.0 release tag is too old — Signal's server rejects its
linking with HTTP 409 / missing capabilities; the pinned commit carries the
libsignal bump that fixes it. sled was removed upstream, so the local store is
sqlite, sqlcipher-encrypted.)

## Components
- `src/main.rs` — link / receive loop (reconnects on websocket drop).
- `src/db.rs` — MariaDB schema (append-only `MIGRATIONS`, run on startup) + inserts.
- `Dockerfile` — Debian build (glibc; presage's crypto fights musl).
- `k8s/` — `00-namespace`, `01-pvc` (DB + presage-store), `02-db` (MariaDB),
  `03-archiver` (the binary), `secret.sh` (generates `signal-secret`).

## Schema
`contacts`, `conversations` (`dm:<uuid>` / `group:<hex master key>`), `messages`
(UNIQUE `(sender_uuid, server_ts)`), `attachments`, `reactions`.

## Deploy (isis k3s, namespace `signal`)
1. Push to `main` → CI builds `xinutec/signal-archiver:latest` (job `signal` in
   `.github/workflows/build.yml`).
2. Create credentials: `./k8s/secret.sh` (random DB creds + store passphrase;
   refuses to overwrite an existing secret).
3. Apply manifests:
   ```
   kubectl apply -f k8s/00-namespace.yaml -f k8s/01-pvc.yaml \
                 -f k8s/02-db.yaml -f k8s/03-archiver.yaml
   ```
4. **Link the device (your phone).** On first start the archiver has no linked
   device, so it logs a provisioning URL. Grab it and render a QR locally:
   ```
   kubectl -n signal logs deploy/signal-archiver | grep '^sgnl://'
   qrencode -t ANSIUTF8 '<that sgnl:// url>'      # nix-shell -p qrencode
   ```
   Scan it in **Signal → Settings → Linked devices → Link new device**. Once the
   phone confirms, the archiver transitions to receiving automatically.
5. Verify rows land: `kubectl -n signal exec deploy/signal-db -- \
   mariadb -usignal -p signal -e 'SELECT COUNT(*) FROM messages;'`

## History backfill (later, one-time)
1. On the Android phone: Signal → Chats → Backups → enable, note the 30-digit
   passphrase, copy the latest `.backup` off the device.
2. Decode with `signalbackup-tools` and import into the same tables (dedupe makes
   it safe to run alongside the live feed). Do the export close to linking to
   minimise the gap. *(Import script to be added when we run this.)*

## v1 scope / known follow-ups
- **Incoming** text, quotes, attachment *metadata*, and reactions are archived.
- **Attachment bytes** are not downloaded yet, and **outgoing** messages
  (linked-device "Sent" sync) aren't captured yet — both need `&manager` while
  the receive stream holds it mutably borrowed, so they're a deliberate second
  pass.
- **Group/contact names** aren't resolved yet (threads are keyed by id);
  resolving needs a profile/group fetch.

## Security
The presage-store PVC holds Signal linked-device keys — it can impersonate the
device. Treat it as secret-class; ensure its odin backup is encrypted. The DB
holds private conversations (same class as `gchat-archive`); real content stays
out of git (`.gitignore`).
