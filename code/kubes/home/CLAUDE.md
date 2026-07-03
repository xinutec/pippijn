# home — Claude working notes

Household-environment dashboard (home.xinutec.org): Hono + Kysely + MariaDB
backend, Angular 22 zoneless frontend, single Docker image, isis k3s ns `home`.

## Toolchain — use the pinned flake, never `nix-shell -p`

`flake.nix` pins node via `nixpkgs` → **nodejs_24 = 24.16.0**, matching CI
(`setup-node@v6`, node-version 24). Get it the right way:

- **With direnv** (set up in home-manager): just `cd` into this dir — `.envrc`
  (`use flake`) auto-activates the locked toolchain; `node`/`ng` are on PATH at
  24.16, GC-rooted so it's not collected.
- **Otherwise:** `nix develop` here, then run npm/ng inside it.

Do **not** use `nix-shell -p nodejs_24`. With no channels subscribed, `<nixpkgs>`
falls through to a stale cached `nixpkgs-unstable` → node **24.14.0**, below
Angular CLI's floor (needs 24.15+), so `ng` refuses to run. Every project pins
its own nixpkgs in its `flake.lock`; the ambient cached one is older and
irrelevant to real builds.

## Verify

`npm run verify` = tsc + tsc(frontend) + biome + ng lint + vitest + frontend
tests. Caveat: plain `tsc -p tsconfig.app.json` does **not** run Angular
strictTemplates — template type errors (e.g. a field missing on the frontend's
own `DeviceLabel`) only surface under `ng build`/`ng test`. Verify templates
with a real `ng build`, not just tsc. The Mac esbuild kqueue assertion that
prints *after* "bundle generation complete" is harmless.

## Deploy

Push to main → CI builds+pushes `xinutec/home:latest` → `scripts/deploy.sh`
(ssh isis, `kubectl -n home rollout restart`). The DB stays raw; no migration
needed for label/offset changes.

## Calibration & room labels

- Per-device temperature offsets: `src/calibration.ts`, applied **client-side**
  and toggleable; the DB is always raw. Re-derived from live data by
  `xinutec-infra/mac-mini/sensor-calibrate.py` (default window: past 24 h). See
  `doc/calibration.md`.
- Room + display labels: `src/labels.ts` (and mirrored on the frontend
  `DeviceLabel` type in `frontend/src/app/measurement.model.ts`). A sensor's
  `room` is a **read-time label keyed by the stable device id** — never stored,
  so moving a unit to another room is a one-line edit here with no migration,
  and its calibration offset travels with it.
