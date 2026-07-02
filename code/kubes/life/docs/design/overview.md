# life — architecture & scope

Personal "life" web app: a single-user home operating system. Owns an
**inventory + spatial model** of the house (what is where) and **recipes**,
and **delegates scheduling/reminders to Nextcloud Calendar** rather than
reinventing them.

Single user (Pippijn). No SLA, no multi-tenant concerns. Hosted on the
xinutec fleet alongside `home` / `health` / `recall`.

The **entire application lives at one origin, `life.xinutec.org`** — one
Angular app + one Rust backend. Every feature (inventory, recipes, the 3D
house) is served from that single domain; there are no per-feature subdomains.
"Domain" elsewhere in this doc and the code (e.g. the *inventory domain*) means
a feature area / bounded context, not a DNS name.

---

## 1. Shape

| Layer    | Choice                                  | Rationale                                         |
|----------|-----------------------------------------|---------------------------------------------------|
| Backend  | **Rust + axum**                         | New; small, explicit auth/session surface.        |
| Frontend | **Angular (TypeScript)**                | Matches `home` / `health` / `recall`.             |
| DB       | **MariaDB via `sqlx`** (own database)   | Same engine as the fleet → uniform ops + backup.  |
| 3D       | three.js in the Angular app             | Render house → highlight searched item.           |
| Host     | isis k3s, own namespace `life`          | Same as `home`/`health`.                          |
| Backup   | restic (Mac mini daily 05:00)           | DB dump folded into the existing restic set.      |

Nextcloud is **not** the database. It is used at two boundaries only:
**identity** (login) and **calendar** (scheduling), both via public APIs —
never schema surgery on NC's own tables.

> **Firm boundary:** the *only* thing managed through NC is the **calendar**.
> Everything else — inventory, locations, recipes, history — lives in life's
> own MariaDB. NC never stores app state.

---

## 2. Nextcloud integration

Learned from the `health` app (`kubes/health/src/nextcloud/*`,
`src/middleware/session.ts`, `src/routes/nextcloud-oauth.ts`). health runs
two deliberately-separate NC flows; life needs **both**, for different reasons
than health did.

### 2a. Identity — OAuth2 authorization-code, identity-only

Establishes *who the user is* and nothing else.

1. `/login` → redirect to NC `index.php/apps/oauth2/authorize`.
2. `/auth/callback` → exchange `code` for an access token.
3. Call `/ocs/v2.php/cloud/user?format=json` **once** for `{id, displayname}`.
4. **Discard the tokens.** Create the app's own session (see §3).

Because the tokens are used once and thrown away, life never holds an NC
**refresh** token, so it never hits the single-use-refresh-token rotation race
that forced health to split its flows in the first place.

Requires an OAuth2 client registered in NC admin → `NC_CLIENT_ID`,
`NC_CLIENT_SECRET`, `NC_REDIRECT_URI` (secrets).

### 2b. Calendar — app password (NC Login Flow v2) → CalDAV

Pure identity-OAuth2 cannot reach the DAV endpoints, so for calendar
read/write life also runs **Login Flow v2** to obtain a long-lived **app
password** (no expiry, no refresh; HTTP Basic Auth), exactly as health does
for PhoneTrack. Stored in life's own `nc_credentials` table.

CalDAV is plain authenticated HTTP against
`/remote.php/dav/calendars/<user>/...`:
- **Read** the bins subscription + existing calendars (`PROPFIND` / `REPORT`).
- **Write** shop-trip events (`PUT` a `VEVENT`).

> **Decision recorded:** "no NC DB writes" is read as *no schema surgery — use
> the public APIs*. Writing a `VEVENT` via **CalDAV** is the supported, clean
> path and is allowed under that rule. We do **not** touch NC's internal app
> tables.

Rust: `reqwest` for HTTP; the `icalendar` crate to serialize/parse `VEVENT`s.

---

## 3. Sessions (life's own, DB-backed)

Copied from health's model — NC is touched only at login; every subsequent
request authenticates against life's own opaque session:

- Random 32-byte id → row in own `sessions` table
  (`user_id`, `display_name`, `expires_at`, 7-day TTL).
- Cookie = `id.HMAC_SHA256(id)`, **timing-safe** verify; `httpOnly`,
  `secure`, `SameSite=Lax`.
- Lazy expiry on read + periodic sweep.
- `require_auth` middleware; single-user (owner-only).
- OAuth `state`: short-TTL, `return_to` **allowlist-validated** (no open
  redirect). health keeps this in-memory per-pod — life should put it in a
  small DB table from the start so a future 2nd replica is safe.

Rust crates: `axum-extra` cookie jar, `hmac` + `sha2`, `rand`,
`constant_time_eq`.

---

## 4. Data model — generic inventory + spatial graph

The core insight: cupboard containment is **general asset tracking**. Build
**one generic engine**, then ship food/recipes as the first skin. Everything
else (meds, tools, documents) later becomes a new category + a few fields,
not a new app.

### Containment (location graph)
```
item → layer → cupboard → room → house
```
- `location` is a node with a `kind` (house / room / cupboard / layer / fridge…)
  and a parent, forming a tree. Registering a new cupboard = inserting a node.
- `cupboard` carries 3D placement (room + position) so the model can be
  rendered and a node highlighted.
- `layer` is an ordered child of a cupboard.

### Item — generic from day one
- `category` (food / med / tool / document / …) — **not** hard-coded to food.
- `quantity`, `unit`, **`expiry`** (first-class, not food-only).
- `location_id` → current node.
- **History/audit** of enter/leave from the start (cheap now, impossible to
  backfill).

### Food / recipes skin
- `recipe` → `recipe_ingredient` (item-ref + amount).
- Derived views: "cook now with what's in stock"; "shopping list = recipe −
  inventory".

### 3D house
- Hand-authored room/cupboard **geometry described parametrically** so that
  "register a cupboard" needs no 3D-modelling step — the Angular/three.js
  layer renders from the data. (A planned "find an item → highlight its
  cupboard/layer in 3D" lookup is parked — the standalone search page was
  removed 2026-07-02; rebuild it with the highlight, not as its own tab.)
- **`position` JSON schema** (metres, floor plane is X–Z, origin at a house
  corner, Y up):
  - room: `{ "x", "z", "w", "d" }` — a footprint rectangle; walls implied.
  - cupboard/fridge: `{ "x", "z", "w", "d", "h" }` — a box.
  - house/layer: no `position`; the house is the container, a layer's vertical
    slot comes from its `sort_order` within the cupboard.
  All fields optional/forward-compatible — the renderer skips nodes without a
  usable box.

### To-do — typed tasks + a connection graph

A **strongly-managed** to-do list: not a flat checklist but *typed* tasks that
can be **connected** to each other and to the rest of life's data.

- **`todo`** — `title`, `type`, `status` (`open` / `done`), optional `notes`.
  - `type` is a **curated enum** that starts minimal — `purchase`, `call` — and
    grows a variant at a time as real kinds appear, not up front.
  - Offline-first exactly like shopping: its own RxDB collection synced through
    `/api/sync/todo`, soft-deleted (tombstones), client-minted `ulid` identity.
- **`todo_link`** — a **typed, directional** edge from one to-do to a target:
  ```
  todo ──kind──▶ target        kind ∈ depends-on | subtask | related
  ```
  - `target` is **polymorphic**: another `todo`, or an app entity —
    `item` / `recipe` / `shopping` / `place` (DB ids) or a house `room` (the room
    *name*, since rooms live in `scenes/house.json`, not the DB).
  - Stored as `(from_ulid, kind, target_kind, target_ref)`, its own synced
    collection (`/api/sync/todo-link`) so links travel offline too.
  - Directionality carries meaning: `depends-on` / blocks (ordering), `subtask`
    (parent → child hierarchy), `related` (plain association).
- **Why a graph, not flags:** "fix the bay-window latch" → `related` to the
  *bay/living room*; "buy a smoke alarm" → `depends-on` the *smoke-alarm item*.
  Modelling each connection as an edge row (rather than baking relationships into
  the to-do) keeps every kind of link uniform and queryable from either end —
  the same "one generic engine" instinct as the inventory model above.
- **Build status:** the `todo` entity ships first (typed list, offline-first);
  the `todo_link` connections layer on top in the following increment.

---

## 5. Scheduling — delegated to NC Calendar

Shop trips and reminders live in **NC Calendar**, not a life table:
- life **writes** "go to <shop>" `VEVENT`s with a `LOCATION` (free-text always
  works; geocoded `GEO`/location-picker depends on the NC version — verify
  before relying on coordinates).
- life **reads** the **bins** subscription
  (`recyclingservices.brent.gov.uk/waste/2081268/calendar.ics`) as an input —
  e.g. *don't schedule a shop the morning the bins go out*.

This shows up in every calendar client for free and removes a whole
scheduling subsystem from life's own DB.

---

## 6. Backup (restic)

life's data is in MariaDB → fold a DB dump into the existing Mac-mini restic
set (`xinutec-infra/mac-mini/hm-agents.nix`, daily 05:00). Restic backs up the
dump file, not the live DB. Wire a pre-backup `mysqldump` of the `life`
database; verify it lands in a restic snapshot.

---

## 7. Initial feature scope (v1)

1. NC login (identity) + session.
2. Generic item/location engine + register-a-cupboard (with layers).
3. Food inventory on top of it (quantity, expiry, "use soon").
4. Recipes + shopping-list / cook-now views.
5. 3D house: render + highlight searched item's location.
6. CalDAV: write a shop-trip event; read the bins feed.

Deferred (the engine makes these cheap later): whole-house inventory (tools,
docs, meds), barcode/phone capture, warranties/manuals.

---

## 8. Open decisions

- three.js parametric geometry vs an authored glTF model of the house.
- Whether barcode capture (phone) is in v1 — it's the make-or-break for
  inventory staying accurate, but adds a mobile surface.
</content>
</invoke>
