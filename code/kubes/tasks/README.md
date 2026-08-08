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

`k8s/secret.sh` is not generated — it is the one thing that must be run on isis
with a person present, because it reads the OAuth client secret from the keyboard
and prints the agent token to the screen rather than putting either in a file.

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

The consequence for TLS is what the model's `exposure` field exists for: Let's
Encrypt cannot complete an HTTP-01 challenge against a name that resolves inside
the tunnel, so the certificate comes from the **DNS-01** issuer
`letsencrypt-dns`. Pairing HTTP-01 with a VPN-only host leaves a certificate
pending forever and surfaces days later as a browser TLS error.

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
# On isis, as root — prompts for the OAuth client, prints the agent token.
./k8s/secret.sh

# On the Mac, with the token it printed.
umask 077 && mkdir -p ~/.config/tasks && cat > ~/.config/tasks/token
```

The OAuth2 client is registered in Nextcloud admin → Settings → Security →
OAuth 2.0, redirect `https://tasks.xinutec.org/auth/callback`.

## Held back

`k8s/06-networkpolicy-app-held.yaml` is **not applied**, for the same reason as
every other app's: k3s enforces NetworkPolicy through kube-router, which does not
exempt node-sourced kubelet probes, so the policy as written drops the liveness
and readiness checks and takes the site down. Applying it needs an ipBlock
admitting the probe source first, then a check that probes stay green.
