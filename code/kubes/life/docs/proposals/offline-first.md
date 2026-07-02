# life — offline-first (local-first) architecture

**Status:** proposal (not yet built). **Reviewed (Opus, 2026-06-29) — decision
resolved: RxDB + MariaDB (stay; do *not* migrate to Postgres).** Review findings
folded in below (see §3a for the reasoning and §14 for the issue resolutions).

Make life fully usable offline — including **creating and editing** inventory,
recipes and shopping items while disconnected — with changes stored on the device
and synced when the network returns. The dashboards (`home`, `health`) get a
lighter read-only offline treatment; `recall` is addressed separately.

Single user (Pippijn). No SLA, no multi-tenant concerns. That single-user fact is
load-bearing throughout: it collapses the hardest part of sync (concurrent
conflict resolution) down to a simple, well-understood case.

---

## 1. Goals / non-goals

**Goals**
- life **opens and runs with no network** (app shell + data both available).
- **Reads** are always served from a local store → instant, offline.
- **Writes** (create / edit / move / delete of items, locations, recipes,
  shopping items) succeed offline, are durable on the device, and **sync
  automatically** when back online.
- The UI never branches on connectivity — it reads/writes locally; sync is a
  background concern.
- Keep the existing **Rust/axum + MariaDB** backend (no datastore rewrite).

**Non-goals**
- Real-time multi-user collaboration / live cursors.
- Conflict-free merge of concurrent edits to the *same field* (CRDTs). With one
  user editing from at most one device at a time in practice, **per-record
  last-write-wins is sufficient** — see §4.
- Offline for `recall` in this doc (it's LAN-only over http, which blocks the
  secure-context APIs offline needs; see §9).

---

## 2. Current state

- Frontend: Angular SPA, plain `HttpClient` REST (`life-api.ts`:
  `POST /api/items`, `PATCH /api/items/:id`, `DELETE /api/items/:id`,
  `POST /api/items/:id/move`, `POST /api/locations`, …). No local store.
- Backend: axum + MariaDB via `sqlx`. Entity IDs are **`BIGINT AUTO_INCREMENT`**
  (server-assigned).
- No service worker anywhere — offline today means the WebView can't even load.
- Delivered to the phone as a WebView wrapper (`org.xinutec.life`).

The AUTO_INCREMENT identity is the single biggest blocker: an offline-created item
has no ID, so a later "move" or "edit" can't reference it. Fixing identity is
prerequisite to everything else.

---

## 3. Decision (summary)

| Question                | Decision                                                            |
|-------------------------|--------------------------------------------------------------------|
| Architecture           | **Local-first**: on-device store is the source of truth; sync reconciles. |
| Local engine + DB       | **RxDB + MariaDB** (own the pull/push handlers). Postgres + ElectricSQL/Zero rejected — see §3a. |
| Identity               | **Client-minted ULID** per syncable row (sortable UUID).           |
| Change tracking        | `updated_at` (logical) + soft-delete `deleted_at` (tombstones).     |
| Conflict policy        | **Per-record last-write-wins** by logical clock.                    |
| Dashboards (home/health)| Service worker + cached GETs only (read-only; no RxDB).            |
| App shell (all https)  | Angular **service worker** so the app code loads offline.           |

## 3a. Engine + datastore — resolved: RxDB + MariaDB (no Postgres migration)

Postgres was put on the table specifically to open the "automatic" sync engines
(ElectricSQL, Zero). The review found that, *for this app*, they don't deliver the
saving — and the single-user fact removes their reason to exist:

- **The Postgres engines solve a problem life doesn't have.** ElectricSQL and Zero
  exist for *server-authoritative, permission-scoped, fan-out reactive sync to many
  clients* (partial replication, shape filtering, live-query fan-out). life is one
  user, one row-owner, an effectively serial write stream, dataset-in-memory. A
  Postgres migration **plus** a pre-1.0 platform dependency would buy machinery for
  problems we provably don't have.
- **They don't even own the hard part (writes).** Current **ElectricSQL** (the
  "shapes" 1.0 product) is **read-path only** — Postgres→client; writes still go
  through your own API and you own the local optimistic state. So it saves the read
  fan-out we don't need, not the write reconciliation we do. **Zero** does read+write,
  but its mutators run as **TypeScript on its `zero-cache` server** — that forks write
  authority out of the Rust/axum backend we want to keep, and it's Postgres-only and
  pre-1.0.
- **Client + auth fit favour RxDB.** RxDB's replication is plain same-origin
  `fetch` (the Nextcloud session cookie rides along, no new auth surface) and its
  observable queries are rxjs-native → clean Angular signals. Electric/Zero deliver
  their ergonomic wins mainly via **React hooks**, and run a **separate sync service**
  that must be fronted by our own cookie-validating proxy — net-new integration, not
  a saving.

**Runner-up worth recording: PowerSync** — a mature managed sync engine that
supports a **MySQL/MariaDB source** (no migration), client SQLite, writes through
your own backend. It's the closest to "automatic without the migration." We still
choose RxDB for the lighter footprint and the rxjs/Angular fit, but MariaDB does
**not** force a hand-rolled-only world — PowerSync is the fallback if owning the
RxDB handlers proves heavier than expected.

So: **stay on MariaDB, use RxDB, own the (small, because single-writer + LWW)
replication handlers.** Rationale for the local-first/LWW picks is in §4.

---

## 4. Why local-first + RxDB + LWW

**Local-first, not "online-first + outbox."** An outbox bolted onto an
online-first app keeps two sources of truth — the cached GET responses and the
queue of unsent writes — and every component must reconcile "server data ∪ my
pending writes" by hand. That rots as the app grows. Making the **local store the
single source of truth** removes the split-brain: the UI reads/writes locally and
is reactive; sync is invisible to feature code.

**RxDB, not hand-rolled sync.** Cost is not the constraint here — *correctness*
is. The sync state machine (checkpoints, tombstones, partial-failure replay,
retry/backoff, conflict hooks, ordering) is precisely what is subtly wrong when
hand-built. RxDB is a mature engine whose replication protocol is *designed* for a
custom backend: you implement a **pull handler** (give changes since a checkpoint)
and a **push handler** (apply writes, report conflicts), and RxDB drives the rest.
It is datastore-agnostic, so MariaDB/axum stays. Its observable queries map
cleanly onto Angular signals/rxjs, so components bind to local data that updates
live as sync lands.

**LWW, not CRDTs.** CRDTs (Automerge/Yjs) earn their complexity when independent
parties concurrently edit the same data and must merge without loss. Here there is
one user, effectively one active device at a time. The realistic conflict is "I
edited item X offline on the phone; meanwhile I'd edited it in the desktop browser
earlier" — resolved correctly by **last-write-wins on a logical timestamp**.
Per-record LWW (not per-field) keeps it simple; the few fields where a merge would
be nicer (e.g. a free-text note) are not worth CRDT machinery for one user.

> **Superseded 2026-07-02:** shipped conflict handling is a **field-level 3-way
> merge** (`frontend/src/app/sync/conflict-merge.ts`): base = the client's
> assumed master, so non-overlapping field edits from two devices both survive;
> a same-field collision keeps the pushing device's value and reports the loser
> to the server-side conflict log (`/api/conflicts`, Conflicts screen —
> keep-mine / use-other). Still no CRDTs.

---

## 5. Data model changes (MariaDB)

**Syncable** (full local-first, RxDB collection): `items`, `locations`, `recipes`,
`recipe_ingredients`, `shopping_items`. **Not syncable:**
- `sessions` / `nc_credentials` — server-only auth state.
- **`products`** — a *shared server-side cache* of Open Food Facts lookups keyed by
  barcode, with `image LONGBLOB`. It has no client writes and must not be replicated
  (don't pull every product blob into IndexedDB). Treat it as a **read-only cached
  GET** (service-worker `dataGroup`), not an RxDB collection. (Review S4.)
- **`item_history`** — written today as a server side-effect of create/move/update
  and impossible to backfill. In local-first those mutations happen on-device, so
  server-derived history would silently stop. Make it a **client-minted, append-only
  syncable collection** (append-only ⇒ no LWW conflicts) so each change is logged
  locally and pushed. (Review S3.)

For each syncable table:

- **`ulid CHAR(26) NOT NULL UNIQUE`** — the client-minted stable identity. The
  existing `BIGINT AUTO_INCREMENT id` stays as the internal PK / FK target, but
  **all sync and all API references use the ULID**. (FKs between syncable tables
  must also carry the related ULID so a child created offline can reference a
  parent created offline — see §6 "dependencies".)
- **`updated_at` as a logical clock**, not wall time. A monotonic per-row version
  the server stamps on every write (a global sequence / `rev` counter is more
  robust than timestamps against clock skew between phone and server). Proposal:
  a server-assigned **`rev BIGINT`** from a monotonic source + keep `updated_at`
  for display.
- **`deleted_at TIMESTAMP NULL`** — soft delete. Deletes become updates that set
  the tombstone; hard purge happens server-side after a retention window.
- **`client_id`** (optional) to attribute a write to a device, for debugging.

A migration backfills ULIDs for existing rows and rewrites FKs to carry the
related ULID.

**`items.quantity` is the one field LWW can't safely own** (Review S9 / §4): it has
*accumulate* semantics, not *replace*. Two offline edits (phone 12→10, desktop
12→9) under record-LWW keep one absolute value and silently drop the other
adjustment — and that's exactly the doc's own motivating scenario. Resolution:
model quantity changes as **deltas/operations** merged additively for this field
only (a tiny op-based path, not full CRDTs); the `item_history` append-log is the
natural carrier. Every other field stays plain LWW.

---

## 6. Sync protocol

RxDB's replication is **checkpoint-based pull + push**, one logical stream
per collection.

**Pull** — `GET /api/sync/{collection}?since={checkpoint}&limit=N`
- Returns rows (incl. tombstones) with `rev > checkpoint.rev`, ordered by `rev`,
  plus the new checkpoint `{rev}`. RxDB pages until drained, then live-pulls
  (poll on an interval / on reconnect; the WebView's Background Sync support is
  unreliable, so triggers are app-foreground + `online` event + a timer).
- **`rev` must be assigned at *commit*, not at write time** (Review S1). A
  sequence assigned mid-transaction can commit out of order (rev 6 visible before
  rev 5); a pull in that window advances the checkpoint past 5 and never delivers
  it. Single-writer makes this rare, not impossible. Fix: assign `rev` via a single
  serialized bump at commit, **or** have the puller refuse to advance the checkpoint
  across an unfilled gap (read with a small safety lag). Test it explicitly.

**Push** — `POST /api/sync/{collection}`
- Body: array of `{ newDocumentState, assumedMasterState }`. The server applies
  each as an **idempotent upsert keyed by ULID**, but only if the server's current
  `rev` matches `assumedMasterState`'s rev (optimistic concurrency). On mismatch
  it returns the **current server doc as a conflict**; RxDB hands it to the
  conflict handler.
- Idempotency: replaying the same push (after a flaky connection) is a no-op
  because upsert-by-ULID is idempotent and the rev guard rejects stale writes.

**Conflict handler (client)** — per-record LWW: keep whichever side has the
higher logical `rev`; if the local write is newer, re-push it; otherwise accept
the server's. Documented and centralised (not per-feature).

**Ordering & dependencies (Review C2 — the real correctness hole).** RxDB
replicates **per collection on independent streams**, so the `items` push and the
`locations` push are *separate requests with no ordering guarantee* — a child can
arrive before its parent exists. This is steady-state, not just an intra-batch edge.
Because we keep the hard `BIGINT` FK for server-internal integrity, every upsert
would otherwise have to translate `location_ulid → location_id` and **fail when the
parent hasn't synced yet**. Resolution: make cross-row links **soft at sync time** —
the syncable row stores the referenced **ULID**, the `BIGINT` FK column is nullable
and resolved (or re-resolved) lazily on a reconciliation pass; never enforce the
hard FK against sync input. Equivalently: drop hard FKs on the syncable graph and
validate referential integrity in application code.

---

## 7. Frontend (Angular + RxDB)

- Define an **RxDB database** with one collection per syncable entity, schema
  mirroring the server (ULID as primary key).
- Replace `life-api.ts`'s direct `HttpClient` calls with **RxDB
  operations**: reads become reactive RxDB queries (`.find().$` → signals);
  writes become local `insert`/`patch`/`remove` (soft-delete) that return
  immediately (optimistic by construction — the local store *is* the truth).
- Wire **replication** per collection to the §6 endpoints; it runs continuously,
  retrying with backoff while offline.
- A small **sync-status indicator** (online / syncing / N pending) in the top bar
  so state is visible.
- ULIDs minted client-side on create.

## 8. Service worker (app shell) — home / health / life

Independent of the data layer, all three https apps add the **Angular service
worker** (`@angular/pwa` → `ngsw-config.json` + `provideServiceWorker`) to
precache the HTML/JS/CSS/icons. For home/health it's paired with ngsw
**`dataGroups`** to cache GET responses → read-only offline dashboards, no RxDB.
Service workers require a **secure context** (https) — fine for these three.

**Critical for life (Review C1): a service worker alone does NOT guarantee an
offline *cold start* in an Android WebView wrapper.** A bare `android.webkit.WebView`
isn't a browser PWA — SW support needs `androidx.webkit ServiceWorkerController`,
and even then serving the **top-level navigation** to `https://life.xinutec.org` on a
cold, offline launch is the unreliable case (the WebView can fail the navigation at
the network layer before any SW intercept). That's the difference between "offline
works" and "the app won't even open" — i.e. Goal #1. Resolution: **bundle the
Angular app shell into the APK** and load it from `file:///android_asset/...` (or a
tiny embedded loader), so cold start never touches the network; the SW then only
caches subresources/data. (Alternative: prove SW navigation-offline under our exact
WebView config before relying on it — but default to bundling.) This makes life's
wrapper a little less trivial than the others; accepted, since cold-offline-open is
the whole point.

## 9. recall (separate track)

`recall` is http on the LAN (`192.168.1.81:8000`), so service workers and other
secure-context APIs **do not run**. To bring recall into the same model it needs
**https** (a local CA / proper cert on the recall host). Out of scope for this
doc; flagged as a follow-on if wanted.

## 10. Alternatives considered

| Option                          | Verdict | Why |
|---------------------------------|---------|-----|
| Online-first + write **outbox** | ✗ | Two sources of truth; reconciliation rots as app grows. |
| **Hand-rolled** local-first sync| ✗ | Reimplements the error-prone sync state machine; higher correctness risk than a proven engine, the opposite of the goal. |
| **PouchDB ↔ CouchDB**           | ✗ | Replaces MariaDB with Couch (or a Couch-compatible target) — abandons the existing backend. |
| **ElectricSQL** (Postgres)      | ✗ | Read-path only today — writes still go through your own API + local optimistic state, so it doesn't own the hard part. Solves multi-client read fan-out we don't have; needs a Postgres migration. (§3a) |
| **Zero / Rocicorp** (Postgres)  | ✗ | Read+write, but mutators run as TypeScript on `zero-cache` → forks write authority out of Rust/axum; Postgres-only, pre-1.0. (§3a) |
| **PowerSync** (MySQL/MariaDB)   | ◐ runner-up | Mature managed engine, **no DB migration**, client SQLite, writes via your backend. Fallback if owning RxDB handlers proves heavy; RxDB preferred for footprint + rxjs/Angular fit. (§3a) |
| **CRDTs (Automerge/Yjs)**       | ✗ | Solve concurrent multi-party merge — unneeded for one user; per-record LWW suffices (except `quantity` → deltas, §5). |
| **TanStack DB / Query persistence** | ◐ | Lighter alternative *within* option A's philosophy; reasonable if RxDB's footprint annoys. |
| **RxDB + MariaDB**              | ✓ chosen | Keeps the stack; proven engine; same-origin fetch fits cookie auth; rxjs-native for Angular. Single-writer + LWW keeps the handler surface small. |
| **RxDB + PostgreSQL**           | ✗ | A migration that buys little — RxDB is datastore-agnostic, so Postgres alone doesn't reduce the sync code. |

## 11. Migration & rollout (phased, each independently shippable)

1. **Backend sync foundation** — schema (ULID, `rev`, `deleted_at`), backfill
   migration, `/api/sync/*` pull+push endpoints, idempotent upserts, rev guard.
   **No dual-writer windows (Review S8):** a row is owned by *either* legacy REST
   *or* sync, never both at once — legacy writes that touch a soon-to-be-synced
   table must bump `rev`/`updated_at` via one shared "touch" in the repo layer, or
   that collection cuts over to sync atomically. Otherwise legacy writes are
   invisible to pull and clients diverge.
2. **Frontend local-first** — introduce RxDB, migrate one collection end-to-end
   (e.g. `shopping_items` — simplest), validate the full offline→sync loop, then
   roll the rest.
3. **Service worker** on life (and home/health in parallel — independent).
4. **(optional) recall https** to extend the model to recall.

## 12. Testing

- Backend: unit-test the upsert/rev-guard (idempotent replay, stale-write
  rejection, tombstone propagation).
- Sync: an integration test of the pull/push loop against a real MariaDB (the
  fleet's test pattern) — create offline → push → pull on a second client →
  converge; conflicting edits → LWW winner.
- Frontend: the offline→online transition (writes queue, then drain) and the
  conflict handler.
- Manual on-device: airplane-mode edits on the Pixel 9 → reconnect → verify
  convergence on the desktop browser.

## 13. Risks & open questions

Resolved by review (now specified above): O-1 logical clock → assign `rev` at
commit / gap-safe checkpoint (§6, S1); O-3 → inter-collection soft FKs (§6, C2);
O-6 licensing → the open-source path (generic `replicateRxCollection` + Dexie/
IndexedDB) needs **no premium plugins**; only OPFS/SQLite storage + encryption are
paid, and we use neither.

Still to decide / watch:
- **Auth expiry is not a clean 401 (Review S6).** Nextcloud session expiry yields a
  **302 → login HTML that `fetch` follows to 200**, not 401. Sync must detect
  "redirected to login / HTML where JSON expected", pause, preserve the queue, and
  prompt re-login on next foreground. Test it.
- **Local-store schema versioning (Review S7).** RxDB collections carry a schema
  `version` + `migrationStrategies`; a bump without a strategy fails to open the DB
  and can drop local data — including unsynced writes. Treat it as load-bearing as
  `migrations/`: every schema change ships a migration strategy, never a silent
  wipe; include a local-migration test in the rollout.
- **Tombstone-purge zombies (Review S2).** A client offline longer than the
  tombstone-retention window misses a delete and re-creates the row. Set retention
  generously **and** force a full re-sync when a checkpoint is older than the purge
  horizon.
- **Delete-vs-update LWW rule (Review K4).** RESOLVED 2026-07-02: tombstones are
  **set-only on the server** (a push can never clear `deleted_at`), the conflict
  handler lets a master tombstone stand, and the one deliberate undelete path is
  the trash restore (`/api/trash/{kind}/{ref}/restore`), which bumps `rev` so the
  resurrection propagates.
- **Compound / derived ops (Review S5).** `buy` (create item + delete shopping row),
  `cookable`, `recipes/:id/shopping-list` are server computations today.
  Local-first reimplements them as local queries; `buy` becomes two cross-collection
  mutations that aren't atomic across sync streams — define them as idempotent,
  replay-safe ULID-keyed pairs.
- **WebView storage durability (O-2, tempered by Review K2).** A dedicated wrapper's
  IndexedDB lives in the app's data dir, cleared only on app-data-clear/uninstall —
  more durable than a browser tab. `storage.persist()` may be a no-op in WebView;
  rely on aggressive flush-on-reconnect + a visible "N unsynced" count.
- **Data at rest is plaintext IndexedDB (Review K1).** Inventory/recipes are
  low-sensitivity and RxDB encryption is premium — plaintext is fine, but it's a
  *stated* decision, not an omission.
- **Observability (Review K3).** Beyond the top-bar indicator, expose a
  per-collection last-synced-`rev` and a way to surface a *stuck* doc (one that
  perpetually loses its conflict and never converges) so a silent wedge is visible.
- **O-5 — initial hydration** size: first full pull — fine at current scale, sanity
  check before rollout.

## 14. Review issue ledger (Opus, 2026-06-29)

Tracking the review's findings to resolution. **Critical:** C1 WebView SW
cold-start → bundle app shell in APK (§8); C2 inter-collection ULID/FK → soft FKs
(§6). **Should-fix:** S1 rev-at-commit (§6), S2 zombie guard (§13), S3
item_history append-log (§5), S4 products = read-only cache (§5), S5 compound ops
(§13), S6 auth-redirect-not-401 (§13), S7 local schema versioning (§13), S8
no dual-writer (§11), S9 quantity deltas (§5). **Consider:** K1 plaintext-at-rest,
K2 durability framing, K3 observability, K4 delete-vs-update rule — all in §13.
Kept as-is (review endorsed): local-first-over-outbox, ULID-as-prerequisite,
rev-over-wallclock, soft-delete tombstones, RxDB checkpoint protocol, Background-Sync
realism, shopping_items-first rollout, recall carve-out.

## 15. As built — collections beyond shopping (2026-06-30)

Shopping was the first collection; the machinery generalised cleanly as more were
added:
- **`todo`** is the second synced collection (typed tasks — see overview §4).
  Same shape as shopping: `ulid` identity, global `rev`, soft-delete tombstones,
  `/api/sync/todo` pull/push.
- The pull/push **envelope is now generic** over the document type
  (`PullResponse<D>` / `PushEntry<D>` in `src/sync/types.rs`), so each collection
  reuses it instead of copying the wire structs. The per-collection part is just
  the doc shape + its pull/push repo functions.
- The to-do **connections** (`todo_link`) are a further collection that stores
  cross-row links **by ULID / soft ref** — another instance of the §6 / C2
  "soft FK at sync time" rule: a link references its target by `ulid`/`target_ref`
  (never a hard FK against sync input), so links and their endpoints sync on
  independent streams without ordering hazards.
