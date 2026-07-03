# home — household environment dashboard

`home.xinutec.org`. Collects readings from the IQAir AirVisual Pro (and any
future sensors) into MariaDB and serves a public Angular/Material dashboard.

The same shape as `health-sync`, but with one key difference: the sensor lives
on the **home LAN**, which isis (in a datacenter) can't reach. So ingestion is
**pushed from the Mac** (which is on the home LAN), not pulled by an in-cluster
cronjob. See `xinutec-infra/mac-mini/airvisual-push.py`.

```
IQAir (home LAN) ──SMB──▶ Mac poller ──HTTPS POST /api/ingest──▶ home.xinutec.org
                                                                    │
                                                  MariaDB ◀── Hono API ──▶ Angular
```

## Android app

A native-feeling phone wrapper — a full-screen WebView onto this dashboard, no
browser chrome. Build & install steps: [`android/README.md`](android/README.md).

## Stack
- Backend: Hono + Kysely + MariaDB (TypeScript, Node 24). Serves the built
  Angular app and the JSON API. Migrations run on startup.
- Frontend: Angular 22 + Material 3, Chart.js. Built into the same image.
- API: `POST /api/ingest` + `/api/ingest/batch` (Bearer `INGEST_TOKEN`),
  `GET /api/devices`, `GET /api/measurements?from&to&device&limit`
  (reads are public).

## Deploy (isis k3s, namespace `home`)
1. DNS: `home` CNAME → `isis.xinutec.org` (in `code/dns/xinutec_org.tf`, `tofu apply`).
2. Secret: `ssh root@isis.xinutec.org 'bash -s' < k8s/secret.sh` (prints the INGEST_TOKEN).
3. Apply manifests (in order):
   ```
   ssh root@isis.xinutec.org 'kubectl apply -f -' < k8s/00-namespace.yaml
   # ...01-pvc, 02-db, 03-app, 05-ingress
   ```
4. Image: push to `xinutec/pippijn` main → CI builds `xinutec/home:latest`.
5. Rollout: `scripts/deploy.sh`.
6. Point the Mac poller at it (store the INGEST_TOKEN in the Mac Keychain),
   then enable the launchd timer.
