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

Each app's Secret is provisioned from the model. `apps/<app>.dhall` declares
every key and, in `origins`, where its value comes from; `generate.sh` renders
that to `dhall/secrets.json` (no values); `plan-run secrets` (xinutec-infra)
reads the table and the cluster:

```sh
cd ~/Code/xinutec-infra/plan
./target/release/plan-run secrets --local-repo ~/Code/pippijn/code/kubes --settings settings.json           # what is missing
./target/release/plan-run secrets --local-repo ~/Code/pippijn/code/kubes --settings settings.json --apply   # make it
```

- **generated** (random), **derived** (from siblings, `DATABASE_URL`) and
  **literal** (not secret, `DB_USER`) keys are made where missing, never over
  a key the Secret holds.
- **typed** and **shared** keys are a person's: give them for one run in a
  mode-600 file of `<app>.<KEY>=<value>` lines with `--values FILE`; the
  table's `note` says where each comes from. Ungiven, the run stops naming the
  key.
- A token a holder needs is read from the live Secret, not printed:
  `ssh root@isis kubectl -n tasks get secret tasks-secret -o jsonpath='{.data.AGENT_TOKEN}' | base64 -d`.
- Rotation is removing the key and running again; a database password also
  changes in MariaDB, which the plan does not do.
- Apps with more than keys (a linked device, an ssh key to another cluster, a
  token for a phone) say so in their `k8s/README.md`.

The one script left, `nextcloud/nextcloud/secret.sh`, holds literals and is
git-crypt'd (its rule is in a nested `.gitattributes`). This repository is
public and unlocked in a working checkout, so judge exposure by what git
stores, not by opening the file:

```
git cat-file blob HEAD:code/kubes/nextcloud/nextcloud/secret.sh | head -c 16
```

`\x00GITCRYPT` means encrypted. Reading the working tree instead has produced
two false "credentials are public" reports. Adding a file with a literal: the
git-crypt rule first, then the literal. A key's value never belongs in the
model.

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
