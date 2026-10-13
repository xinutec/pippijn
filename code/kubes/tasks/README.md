# tasks

The work Claude sessions and Pippijn hand between each other. Repo:
`github.com/xinutec/tasks`.

`https://tasks.xinutec.org` — Nextcloud sign-in, `pippijn` only, plus a shared
bearer token for the Claude sessions on the Mac.

## What is where

The manifests in `k8s/` are **generated** from `dhall/apps/tasks.dhall`. Change
the model and re-render (`dhall/generate.sh`); hand edits are overwritten.
`dhall/generate.sh --check` reports whether the model and this tree still
describe the same cluster.

The Secret is provisioned from the model by `plan-run secrets` (see
`code/kubes/README.md`, "Secrets"): the database credentials, the session
secret and the agent token are generated; the OAuth client is the one thing a
person gives, with `--values`.

## The database is the record, and that is why it is backed up

Unlike memview beside it, this app holds a primary copy. The scheme it replaced
kept tasks as files in each repository, so **git** was the history — what was
finished, and when. There is no git here: the `tasks` database holds the only
record of who was carrying what, in `tasks` and `task_events`. Losing it loses
the backlog and every handover in it.

## Why the hostname resolves to 10.100.0.2

`tasks.xinutec.org` points at isis's WireGuard address, so the name is not
advertised to the internet. **This is obscurity, not a firewall** — the isis
ingress answers on the public IP too, so anyone who knows the address reaches the
same app. The real gate is the Nextcloud login plus the `pippijn`-only allow
list, and the bearer token for the machine clients.

TLS terminates at isis's host nginx, whose certificates come from
`security.acme` over DNS-01, so a name that resolves inside the tunnel still
gets one.

## Two clients, and only one of them is a browser

| client | credential | where it runs |
| --- | --- | --- |
| the phone / the desk | Nextcloud sign-in → HMAC session cookie | anywhere on the VPN |
| a Claude session | `AGENT_TOKEN` + an `X-Session-Id` header | the Mac |

⚠ **`AGENT_TOKEN` is a required secret reference, not an optional one.** Unset,
the agent API closes and every session's task list goes silent — while the app
itself looks perfectly healthy and the browser works. The app logs a warning at
startup for exactly this reason.

⚠ **It authenticates the machine, not the conversation.** Every session on the
Mac reads the same value out of `~/.config/tasks/token`, so one holding it can
act as another by declaring a different session id. They run as one user on one
machine and can read each other's transcripts anyway, so nothing is lost by
this — but it must not be described as per-session authentication.

## Deploy

1. `git push` the app repo → CI builds and pushes `xinutec/tasks:latest`.
2. `kubectl -n tasks rollout restart deploy/tasks` — nothing on this fleet
   watches image tags, so a push alone changes nothing on the cluster.
3. Manifest changes are **not** picked up by a rollout: apply the yaml.

```sh
cat k8s/03-app.yaml | ssh root@isis.xinutec.org 'kubectl apply -f -'
```

## First-time setup

```sh
# From the Mac: make the keys, giving the OAuth client in a 600 file.
plan-run secrets --local-repo ~/Code/pippijn/code/kubes --settings … --values FILE --apply

# The agent token, read from the live Secret into the Mac's file.
umask 077 && mkdir -p ~/.config/tasks
ssh root@isis kubectl -n tasks get secret tasks-secret -o jsonpath='{.data.AGENT_TOKEN}' \
  | base64 -d > ~/.config/tasks/token
```

⚠ The plan never rewrites a key it finds, so re-running it is safe once the app
holds work. Rotating `DB_PASSWORD` for real means changing it in MariaDB and
removing the key from the Secret together; rotating the agent token costs every
Mac session its list until the new one is copied across.

The OAuth2 client is registered in Nextcloud admin → Settings → Security →
OAuth 2.0, redirect `https://tasks.xinutec.org/auth/callback`.
