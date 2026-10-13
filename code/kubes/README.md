# kubes — cluster manifests, and how they reach the cluster

## Deploying

```
./<app>/k8s/sync.sh
```

Every one of those is a few lines. They all `exec` [`deploy.sh`](deploy.sh), which
is the only implementation — it runs the `deploy` plan from
[`xinutec-infra/plan`](../../../xinutec-infra/plan/README.md) in apply mode.

There were ten hand-written `sync.sh` scripts until 2026-07-31. Six spelled out
the same procedure — `cd`, apply a hand-listed file sequence, `rollout restart`,
`rollout status` — differing only in namespace, file names and timeouts. They had
diverged: observe's copy was missing the `rollout restart` line the others had,
so a ConfigMap change applied and never took effect. The nginx telemetry endpoint
was live-but-inert for a day, and the drift collector found it rather than
anything in the deploy path.

## What a deploy refuses

Nothing reaches the cluster unless, in order: no manifest mixes a held resource
with an applied one, the repo is on `main`, nothing under the app's `k8s`
directory is uncommitted, `HEAD` is pushed, and the host's checkout is at that
same commit — the last of which is now *fixed* rather than refused, since a
commit already on origin has been through the bar that matters.

**This is stricter than the scripts were**, in one way worth knowing: they ran
`kubectl apply` from your machine against LOCAL files, so an uncommitted manifest
could be deployed. This deploys the host's checkout. Iterating by deploying an
uncommitted edit no longer works, which is the guards doing their job.

## What it does that the scripts did not

- Excludes `*-held.yaml`. A hand-listed `-f` sequence excluded them only by
  accident, and would have stopped the moment someone added a file.
- Applies nothing when the cluster already matches, where the scripts applied
  unconditionally.
- Restarts only workloads on a `:latest` tag, and only when the registry says the
  running image is behind — so a deploy of an already-current app is a genuine
  no-op. A pinned database is never restarted; the scripts that named their app
  Deployment explicitly got this right, and an early version of the replacement
  did not.

## Secrets

Each app's Secret is provisioned from the model, not by a script. `apps/<app>.dhall`
declares every key and, in `origins`, where its value comes from; `generate.sh`
renders that to `dhall/secrets.json` with no value in it, and `plan-run secrets`
(xinutec-infra) reads the table and the cluster:

```sh
cd ~/Code/xinutec-infra/plan
./target/release/plan-run secrets --local-repo ~/Code/pippijn/code/kubes \
  --settings settings.json            # which declared keys are missing, by name
./target/release/plan-run secrets --local-repo ~/Code/pippijn/code/kubes \
  --settings settings.json --apply    # make the ones a tool can
```

- A **generated** key is random bytes, made at that moment and never shown; a
  **derived** one is composed from its siblings (`DATABASE_URL`); a **literal**
  one is a value that is not secret (`DB_USER`). All three are made where
  missing and never over a key the Secret holds.
- A **typed** key is a person's: the table's `note` says where it comes from
  (the Nextcloud OAuth2 client, the Fitbit application, …). Give it for one run
  in a file of `<app>.<KEY>=<value>` lines, mode 600, with `--values FILE`; the
  value is read at the moment of acting and is in no argument, log or plan.
  Without it the run stops naming the key.
- A **shared** key is a list of per-holder entries (`FLEETWATCH_TOKENS`,
  `INGEST_TOKENS`), given whole the same way; xinutec-infra's credentials table
  names each holder's copy and checks it hourly.

A generated token that a holder needs (the Mac's tasks token, recall's sync
token) is read from the live Secret, not printed anywhere:

```sh
ssh root@isis kubectl -n tasks get secret tasks-secret -o jsonpath='{.data.AGENT_TOKEN}' | base64 -d
```

**Rotating** a key is removing it and running again — and for a database
password, changing it in MariaDB too, which the plan does not do:

```sh
ssh root@isis kubectl -n coach patch secret coach-secret --type json \
  -p '[{"op":"remove","path":"/data/SESSION_SECRET"}]'
```

The apps with more to do than keys — a linked device, an ssh key to another
cluster, a token handed to a phone — say so in their own `k8s/README.md`.

The one script left, `nextcloud/nextcloud/secret.sh`, holds literal credentials
and is encrypted with git-crypt; its rule lives in a **nested** `.gitattributes`
beside it, not in the repo root's. This repository is **public**, and it is
**unlocked in a working checkout**, so that file reads as plaintext locally
while being ciphertext on GitHub. Do not judge exposure by opening a file; ask
git what it stores:

```
git cat-file blob HEAD:code/kubes/nextcloud/nextcloud/secret.sh | head -c 16
```

A `\x00GITCRYPT` prefix means encrypted. Reading the working tree instead produced
a false "credentials have been public for 19 months" report on 2026-08-07, and a
second one on 2026-10-13 about health's former `secret.sh`.

**Adding a file that needs a literal credential? Add its git-crypt rule first,
then the literal** — in that order, or the plaintext is in history for good.
A key's VALUE never belongs in the model: `Literal` is for a value that is not
secret.

## Helm releases

Every Helm release is a row in xinutec-infra's `plan/tables/helm.dhall`, judged
by the `helm` plan (the release on record against what the row renders, and
against what the cluster holds) and applied by it with `plan-run helm --apply`
from the Mac. That is mailu alone since 2026-10-04: amun's edge is the host's
nginx, as isis's is (nixos-config `frontdoor.nix`), which issues the
certificates too, so ingress-nginx and cert-manager are gone.

What mailu keeps outside its chart on purpose (its redis and roundcube Secret)
is a plain `<app>/k8s` tree since 2026-10-03, deployed like any other: its
`sync.sh` is the door onto `deploy.sh`, and the cluster comes from
`dhall/placed.dhall`, since no model places it.

`nextcloud` is a plain tree too since 2026-10-03, with its Redis (`redis.yaml`)
in place of bitnami's chart and the same door, on isis.
