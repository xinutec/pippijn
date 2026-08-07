# kubes — cluster manifests, and how they reach the cluster

## Deploying

```
./<app>/k8s/sync.sh
```

Every one of those is two lines. They all `exec` [`deploy.sh`](deploy.sh), which
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

## Secrets, and why most `secret.sh` are readable

Each app has a `k8s/secret.sh`, run once on the host to create its k8s secret.
**Ten of the twelve are plaintext in git, and that is correct**: they generate
every credential at run time (`openssl rand`, `/dev/urandom`), so the only
literals in them are usernames like `DB_USER=coach`.

The two that DO hold literal credentials — `nextcloud/nextcloud/secret.sh` and
`health/k8s/secret.sh` — are the two encrypted with git-crypt. The rule for the
first lives in a **nested** `.gitattributes` beside it, not in the repo root's,
so the root list is not the whole picture.

This repository is **public**, and it is **unlocked in a working checkout**. Those
two files therefore read as plaintext locally while being ciphertext on GitHub.
Do not judge exposure by opening the file; ask git what it stores:

```
git cat-file blob HEAD:code/kubes/nextcloud/nextcloud/secret.sh | head -c 16
```

A `\x00GITCRYPT` prefix means encrypted. Reading the working tree instead produced
a false "credentials have been public for 19 months" report on 2026-08-07.

**Adding an app whose secret.sh needs a literal? Add its git-crypt rule first,
then the literal** — in that order, or the plaintext is in history for good.

## Not covered

`cert-manager`, `ingress-nginx`, `mailu-mailserver` and `nextcloud` keep their
own `sync.sh`. They are helm installs or a different shape, not the six-line
procedure, so folding them in would mean inventing a second thing for
`deploy.sh` to be.
