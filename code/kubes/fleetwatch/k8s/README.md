# fleetwatch — what its Secret needs beyond keys

The keys are the model's (`dhall/apps/fleetwatch.dhall`, `origins`); `plan-run
secrets` makes the database credentials and the session secret. Two keys are
lists shared with holders, given whole with `--values`:

- `FLEETWATCH_TOKENS`: one `host:token` pair per producer, comma-separated.
  Each host's copy sits at `/var/lib/fleetwatch/token` (0600), and
  xinutec-infra's credentials table names every one, so the hourly check sees
  a copy that drifts. ⚠ Read the live list from the live Secret before changing
  it, never from memory: a producer joins whenever a host starts pushing, and a
  rewrite from a stale list silently deauthorises every producer it omits. To
  add a producer, append a pair to the live key and restart the app.
- `FLEETWATCH_READ_TOKENS`: the read tokens, which open `GET /api/problems` and
  nothing else. The phone's background poller holds one (it cannot complete an
  interactive Nextcloud login from a WorkManager job); the Mac's `board` holds
  another in the Keychain (`security add-generic-password -a fleetwatch -s
  fleetwatch-read-token -w '<token>' -U`), and `android/deploy.sh` injects the
  phone's. Read-only and single-endpoint, so a lost phone leaks neither write
  access nor the report history.

The Nextcloud OAuth2 client (the human login gate) is registered by hand in
dash → Admin → Security → OAuth 2.0 clients with redirect URI
`https://fleetwatch.xinutec.org/auth/callback`; rotating it means
re-registering there.
