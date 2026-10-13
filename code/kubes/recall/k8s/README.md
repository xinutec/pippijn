# recall — what its Secret needs beyond keys

The keys are the model's (`dhall/apps/recall.dhall`, `origins`). Two generated
tokens are each one client's, and are read from the live Secret to be handed
over; nothing prints them:

- `SYNC_TOKEN`: the Mac's bearer for `/sync/*` (push audio and transcripts,
  poll jobs). The Mac is a one-way WireGuard peer, it dials the fleet and
  nothing dials back, so this authenticates the Mac to isis, not the other way
  round. Without it `recall.sync` registers no routes at all: isis stays a
  plain LAN web UI and the migration is inert, deliberately (fail closed). It
  goes to `~/.config/recall/sync-token` on the Mac (0600).
- `DEVICE_TOKEN`: the Android app's bearer for `POST /api/sessions` (uploads),
  set in the app's Settings → "upload token". Separate from the sync token on
  purpose: a phone is easier to lose than a Mac, and the sync token opens the
  whole archive surface. Losing the phone costs uploads, not the archive.

`INGEST_TOKENS` is a shared list, one `host token` entry per recorder, given
whole with `--values`; xinutec-infra's credentials table names geb's copy
(`/var/lib/recall-secrets/env`) and checks it hourly.

Rotating one token stops that client until the new value is copied across.
Every optional key (`SESSION_SECRET`, the Nextcloud client) is read with
`optional: true`, so losing one does not crash the pod: it silently drops the
Nextcloud sign-in wall and leaves recall open to anything on the VPN. The plan
never rewrites a key it finds, which is what makes that loss impossible by
re-running it. The pod reads the Secret at start: `kubectl -n recall rollout
restart deploy/recall` after a change.
