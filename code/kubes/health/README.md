# health-sync

Fitbit + Owntracks/PhoneTrack data ingestion, classification, and dashboard.
Lives at https://health.xinutec.org.

## Layout

```
src/         backend (Hono + Kysely + MariaDB)
frontend/    Angular SPA (Material)
tests/       backend tests (vitest)
scripts/     utility scripts
docs/        design + proposals — see docs/README.md for the index
```

## Common commands

| Command | What it does |
|---|---|
| `npm run verify` | Typecheck (back + front) → schema-types check → format → Biome lint (back) → ESLint (front) → tests. Run before every commit. |
| `npm test` | Just the backend test suite. |
| `npm run analyze -- YYYY-MM-DD` | Run the day-analysis CLI locally (needs DB + Nextcloud env vars). |
| `bash scripts/deploy.sh -m "msg"` | Full deploy: verify → stage `code/kubes/health/` → commit → push → wait for CI → kubectl rollout on isis. See the script header for `-F file` usage and prerequisites. |

## Deployment

Production runs as `deploy/health-auth` in the `health` namespace of the
isis k3s cluster. The Docker image is built by GitHub Actions on every push
to `main` and pulled by the cluster on rollout.

`scripts/deploy.sh` is the one-step path. The manual equivalent is:

```
npm run verify                                         # in code/kubes/health/
git add code/kubes/health/ && git commit -F msg.txt    # from pippijn root
git push origin main
gh run watch --exit-status <run-id>
ssh root@isis.xinutec.org \
  'kubectl -n health rollout restart deploy/health-auth && \
   kubectl -n health rollout status  deploy/health-auth --timeout=180s'
```

## Linters

- **Biome** — backend (`src/`, `tests/`). Format + general TS lint.
- **ESLint + angular-eslint** — `frontend/src/`. Angular semantics
  (inline-template ban, template a11y, etc.) that Biome can't see.
  Both run as part of `npm run verify`.

## More

See `docs/README.md` for design docs, proposals, and architecture notes.
