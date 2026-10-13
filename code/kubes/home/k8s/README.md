# home — what its Secret needs beyond keys

The keys are the model's (`dhall/apps/home.dhall`, `origins`); `plan-run
secrets` makes the database credentials, the session secret and
`INGEST_TOKEN`. The ingest token is the Mac poller's: it goes into the Mac's
Keychain so the poller can `POST /api/ingest`, read from the live Secret rather
than printed:

```sh
ssh root@isis kubectl -n home get secret home-secret -o jsonpath='{.data.INGEST_TOKEN}' | base64 -d
```

The Nextcloud OAuth2 client is registered by hand (Settings → Security →
OAuth 2.0 clients, redirect `https://home.xinutec.org/auth/callback`) and given
with `--values`; it cannot be generated, and the plan never rewrites a key it
finds, so a working pair is never clobbered.
