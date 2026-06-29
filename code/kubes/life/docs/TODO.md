# Life — roadmap & TODO

Living checklist for the Life app. Keep it current: tick items as they ship,
add new ones under the right section. Architecture/rationale lives in
`docs/design/overview.md`; this is the "what's done / what's next" tracker.

## ⚠️ Top priority before real reliance

- [ ] **Back up the Life DB** — the `life` MariaDB on isis (ns `life`, deploy
  `life-db`, PVC `life-db-pvc`) has **no backup**. Lose the PVC → lose all
  inventory/recipes/places. Plan: scheduled `mysqldump` folded into the
  Mac-mini **restic** set (`xinutec-infra/mac-mini/hm-agents.nix`, daily 05:00).
  Deferred deliberately until there's real data worth protecting — revisit now
  that the app is in use. (overview §6)

## Shipped

- [x] Nextcloud identity login (OAuth2) + own DB-backed HMAC sessions
- [x] Generic location/item engine (house→room→cupboard→fridge→layer)
- [x] Inventory: register/delete places, add/edit/move/delete items (CRUD)
- [x] Food fields: category, quantity, unit, expiry (stored)
- [x] Recipes: create/delete, ingredients, shopping-list, cook-now
- [x] Search → location breadcrumb ("where is my X")
- [x] 3D house renders the real `scenes/house.json` (perimeter walls + furniture)
- [x] Mobile-first UI (bottom tabs ↔ side rail), management forms, NC avatar
- [x] Deployed: isis k3s, CI/CD (`xinutec/life`), DNS, TLS, live login
- [x] Wordmark "Life"

## Next up

- [ ] **Expiry / "use soon" view** — surface `expiry` (sort/flag soon + expired).
      Data already stored; just needs a view.
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

- [ ] **Barcode / phone capture** for fast item entry (make-or-break for the
      inventory staying accurate). Adds a camera surface.
- [ ] **Shopping list as its own surface** — aggregate across recipes + low
      stock, tickable; sync to phone.
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
