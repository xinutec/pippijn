# memview

Read-only viewer for the Claude memory corpus. Repo: `github.com/xinutec/memview`.

`https://memview.xinutec.org` — Nextcloud sign-in, `pippijn` only.

## What is where

The manifests in `k8s/` are **generated** from `dhall/apps/memview.dhall`. Change the
model and re-render (`dhall/generate.sh`); hand edits are overwritten. `dhall/generate.sh
--check` reports whether the model and this tree still describe the same cluster.

`k8s/secret.sh` is not generated — it is the one thing that must be run on isis with a
human present, because it reads the OAuth client secret from the keyboard rather than from
a file or an argument.

## The corpus is not in the image

The image carries the viewer. The memories are a volume, pushed up from the Mac by
`scripts/sync.sh` in the app repo. Nothing about the corpus is baked in, published to
Docker Hub, or committed to a repo — which is why the app repo can be public.

Sync direction is deliberate and one-way. The Mac is the root of truth and the only
machine on the VPN that nothing else can reach; isis is the exposed, disposable mirror. A
compromised server must not be able to reach back and delete the archive. If the copy here
is ever wrong, re-run the sync — never recover from the server.

## Why the hostname resolves to 10.100.0.2

`memview.xinutec.org` points at isis's WireGuard address, so the name is not advertised to
the internet. **This is obscurity, not a firewall** — the isis ingress answers on the
public IP too, so anyone who knows the address reaches the same app. The real gate is the
Nextcloud login plus the `pippijn`-only allow list.

The consequence for TLS is what the model's `exposure` field exists for: Let's Encrypt
cannot complete an HTTP-01 challenge against a name that resolves inside the tunnel, so
the certificate comes from the **DNS-01** issuer `letsencrypt-dns`. That ClusterIssuer must
exist on isis — it is not there by default. Pairing HTTP-01 with a VPN-only host leaves a
certificate pending forever and surfaces days later as a browser TLS error.

## Deploy

1. `git push` the app repo → CI builds and pushes `xinutec/memview:latest`.
2. `kubectl -n memview rollout restart deploy/memview` — nothing on this fleet watches
   image tags, so a push alone changes nothing on the cluster.
3. Manifest changes are **not** picked up by a rollout: apply the yaml.

```sh
cat k8s/03-app.yaml | ssh root@isis.xinutec.org 'kubectl apply -f -'
```

## First-time setup

```sh
# On isis, as root — prompts for the OAuth client id and secret.
./k8s/secret.sh

# From the Mac, once the pod is Running.
~/Code/memview/scripts/sync.sh
```

The OAuth2 client is registered in Nextcloud admin → Settings → Security → OAuth 2.0,
redirect `https://memview.xinutec.org/auth/callback`.

## Held back

`k8s/06-networkpolicy-app-held.yaml` is **not applied**. k3s enforces NetworkPolicy through
kube-router, which does not exempt node-sourced kubelet probes, so the policy as written
drops the liveness and readiness checks and takes the site down. Applying it needs an
ipBlock admitting the probe source first, then a check that probes stay green.
