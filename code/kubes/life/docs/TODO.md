# Life — roadmap & TODO

Living checklist for the Life app. Keep it current: tick items as they ship,
add new ones under the right section. Architecture/rationale lives in
`docs/design/overview.md`; this is the "what's done / what's next" tracker.

## Backup — deliberately NOT yet (wait for Pippijn's go)

- [ ] **Back up the Life DB** — **DO NOT set this up yet.** It matters *after*
  the system is developed and the DB schema is **stable**; while migrations are
  still being added, a backup is premature. Pippijn will say when to start —
  don't start, offer to start, or flag it as overdue before then.
  When the time comes: scheduled `mysqldump` of the `life` DB on isis (ns
  `life`, deploy `life-db`, PVC `life-db-pvc`) folded into the Mac-mini
  **restic** set (`xinutec-infra/mac-mini/hm-agents.nix`, daily 05:00). Until
  then the PVC is the only copy — that's an accepted, temporary state. (overview §6)

## Shipped

- [x] Nextcloud identity login (OAuth2) + own DB-backed HMAC sessions
- [x] Generic location/item engine (house→room→cupboard→fridge→layer)
- [x] Inventory: register/delete places, add/edit/move/delete items (CRUD)
- [x] Food fields: category, quantity, unit, expiry (stored)
- [x] Recipes: create/delete, ingredients, shopping-list, cook-now
- [x] Shopping list ("Buy" tab): add/tick/remove + buy→inventory loop
- [x] Product lookup: barcode → Open Food Facts, cached in our DB (image as
      BLOB, served from /api); barcode field + thumbnails on Buy/Inventory
- [x] Camera barcode scanner (native BarcodeDetector, graceful fallback) on
      Buy + Inventory → scans the code, fills it, runs the lookup
- [x] Search → location breadcrumb ("where is my X")
- [x] 3D house renders the real `scenes/house.json` (perimeter walls + furniture)
- [x] Mobile-first UI (bottom tabs ↔ side rail), management forms, NC avatar
- [x] Deployed: isis k3s, CI/CD (`xinutec/life`), DNS, TLS, live login
- [x] Wordmark "Life"

## Next up

- [ ] **Expiry / "use soon"** — surface `expiry` (sort/flag soon + expired).
      Data already stored. (A first `/expiring` view was built then removed
      2026-06-29 — Pippijn wants a different approach; redo from scratch.)
- [ ] **Extend `scenes/house.json` to the whole house** — Pippijn measures the
      remaining rooms; decide how rooms compose (shared origin / offsets).
- [ ] **Place cupboards in scene coordinates** → re-wire **search → highlight in
      3D** (currently parked: the demo box-highlight was removed). Decide how
      DB locations map to scene geometry.
- [ ] **CalDAV** — read the Brent bins feed; write "shop trip" `VEVENT`s with a
      location. Needs the Login-Flow-v2 app-password link (overview §2b, §5).
- [ ] **Frontend test runner** — none yet (vitest, like recall). Cover the pure
      helpers (scene-geometry, matching) + key components.

## Backlog

- [ ] **Product extras** — name+image copied onto items at add-time (currently
      items carry the barcode and the thumbnail is fetched live from the cache —
      fine, but not self-contained if the cache is wiped); camera photo +
      paste-URL→`og:image` as alternative image sources; manual "refresh from
      OFF"; a `@zxing/browser` fallback for non-Chromium browsers (the native
      BarcodeDetector scanner only works on Chromium); contribute missing
      products back to OFF (uses Pippijn's OFF account — creds user-held).
- [ ] **Purchases: shop + price observations** (design decided) — price is NOT
      a product attribute; it varies by shop and time, so model it as an
      **observation = the same record as "where bought"**:
      - A `price_observations` row: `barcode`/product, `shop`, `amount`,
        `currency` (ISO, default GBP), `quantity` + `unit` (the pack the price is
        for, → derive **price-per-unit** for fair shop comparison), `observed_at`,
        `source` (bought / seen).
      - **Amount as DECIMAL(10,2) or integer minor-units — never float** (money
        must be exact; unlike `quantity`, which is DOUBLE).
      - Captured at the **buy→inventory** step (mark bought → optionally enter
        shop + paid). Derive: latest price, **cheapest shop**, price history,
        "where can I buy X", and an estimated Buy-list total.
      - Our observations are the source of truth; **don't trust OFF for price**
        (hyper-local/stale; Open Prices is at most a hint).
      - MVP: capture shop + amount at buy-time. Later: per-unit ranking,
        cheapest-shop, estimated totals, shop-trip scheduling via NC Calendar
        (overview §5).
- [ ] **Shopping list refinements** — add a recipe's missing ingredients to the
      Buy list in one tap; low-stock auto-suggestions; carry category through
      buy→inventory (currently defaults to `other`).
- [ ] **Whole-house inventory** — surface non-food categories in the UI (tools,
      documents, meds); the engine is already generic.
- [ ] **Meds / supplements** — expiry + refill-soon (fits the generic engine).
- [ ] **Warranties / receipts / manuals** — attach a file + purchase/expiry date.
- [ ] **Item history view** — the `item_history` audit is recorded but unshown.
- [ ] **House polish** — camera/lighting, per-cupboard layer visualisation,
      tap-a-cupboard-to-list-its-items.
- [ ] **PWA polish** — full icon set (png/maskable/favicon, not just svg),
      offline shell.

## Open decisions

- three.js parametric geometry vs an authored glTF model of the house.
- How scene cupboards relate to the DB location tree (store `position` on the
  `location` rows, vs keep scene geometry separate and map by id/name).
- Whether barcode capture is worth the mobile-camera surface.
