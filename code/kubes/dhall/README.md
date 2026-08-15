# Typed fleet model

The Kubernetes manifests under `code/kubes/<app>/k8s/` are hand-copied between
apps. Six of them share the same skeleton — namespace, PVC, MariaDB, app,
ingress, netpol — and have drifted apart in ways nothing checks. This directory
is a Dhall model of what those manifests *mean*, from which the YAML is
rendered.

Dhall was chosen because it is statically typed, **total** (every expression
terminates), and cannot perform IO. Rendering a manifest is therefore pure
evaluation: `--check` is a real dry run, and the model can't reach the network
or the cluster while producing it.

## Layout

| Path | What it is |
| --- | --- |
| `lib/types.dhall` | the schema an app is written against |
| `lib/k8s.dhall` | the subset of the Kubernetes API this fleet uses, as types |
| `lib/render.dhall` | `Namespace` → Kubernetes resources |
| `lib/site.dhall` | the second type: a static site, which is not an `App` |
| `lib/list.dhall` | `map`/`concatMap` (hand-written so no remote import is needed) |
| `dns.dhall` | every hostname the fleet serves |
| `apps/*.dhall` | one value per app — the part a human edits |
| `sites/*.dhall` | one value per static site |
| `generate.sh` | render, or `--check` against the live tree |
| `normalize.py` | canonicalises YAML so `--check` compares meaning, not text |

`App` is the one-workload case of `Namespace`, and `namespaceOf` is the only
expression that says so — everything renders through the `Namespace` path.

## Usage

```sh
./generate.sh            # render to generated/<app>/
./generate.sh --check    # diff the model against the live <app>/k8s/ tree
```

The toolchain is pinned in `flake.lock`; `generate.sh` re-execs itself inside
`nix develop` if Dhall isn't on `$PATH`.

`--check` compares each app's whole manifest *set* rather than file by file,
because the live tree numbers the same resources differently per app
(`home/05-ingress.yaml` vs `life/04-ingress.yaml`). The question worth answering
is whether the model describes the same cluster state.

## What the types buy

These are the invariants that stop being things a linter re-derives after the
fact and start being things that don't typecheck:

- **No version-pinned fleet image.** `Image.Fleet` has no tag field, so
  `xinutec/<app>:latest` is the only expressible form. Roll-forward is not a
  convention here, it is the type.
- **No mismatched names.** Namespace, labels, selectors, Service names, the
  Ingress backend and `secretKeyRef.name` are all derived from one expression.
  A Service selector cannot disagree with its pod template.
- **No undeclared secret key.** Each app declares a `keys` record and refers to
  its fields; `keys.INGST_TOKEN` is a type error rather than a pod that boots
  with an unset variable. `toMap keys` hands the same set to the App, so what
  MariaDB reads and what `secret.sh` provisions cannot drift.
- **No undeclared hostname.** Ingress hosts come from `dns.dhall` as record
  fields. `life`'s OAuth redirect URI is built from the same value the Ingress
  serves, so the callback can't drift from where the app lives.
- **No container without limits.** `Resources` requires both halves.
- **No unprotected database.** The DB NetworkPolicy renders whenever an app has
  a database; "has a DB, nothing in front of it" is unrepresentable.
- **No misspelled API field.** `lib/k8s.dhall` models only the fields we use, so
  `containerPorts` fails to typecheck instead of being silently ignored.

Fleet-wide facts live in one place: the MariaDB version is one line in
`render.dhall`, not six copy-pasted image strings.

## Status

**DONE — 16 of 16, generated, deployed, and the apply converges** (2026-08-14).
Every modelled tree carries a `GENERATED from` header, `generate.sh --check`
reports `model matches the live tree` for all of them, and a second
`apply --dry-run=server` comes back clean.

- **13 apps** — `apps/*.dhall` through `lib/types.dhall`: coach, fleetwatch,
  health, home, life, memview, messages, observe, recall, scanner, signal,
  tasks, utterance.
- **3 static sites** — `sites/*.dhall` through `lib/site.dhall`, a SECOND type:
  amun, isis, slides.

`generated/` is gitignored; the cut-over tree under `<app>/k8s/` is what is
committed and applied.

⚠ **Adding a TYPE beat grinding through apps, and the margin was 3:1.** Seven
trees was the ceiling for `T.App` alone. Ranking the rest by line count was
wrong — size is not the cost, **conformity to the single shape the type
describes is**. `lib/site.dhall` then moved the number by four, three of them
byte-identically with no cluster change at all. Size the next batch by reading a
whole subject, not one dimension of it: a change measuring only how three trees
were *reached* unlocked zero.

**`vaultwarden` is deliberately not modelled.** The only way in is making
`runAsNonRoot`, seccomp and cpu limits optional — weakening the exact invariants
the model exists for, for the password vault.

⚠ **`generate.sh --check` cannot report the gap**, because it iterates
`apps/*.dhall`: its universe IS the model, so it is green over what is modelled
and silent about the rest. `check_generated_manifests` in dev-lint's `fleet.py`
walks for `k8s/` directories instead and prints the ratio on every `./check`.

⚠ **NEVER run `dhall format` on this tree.** It discards comments — measured
313 → 40 lines on `lib/types.dhall`, 217 → 79 on `render.dhall` — and the
reasoning in those comments is the most valuable part of the files. Nothing
catches it: the rendered YAML is identical, because comments never reach the
output.

### The rule the cutover settled

**Bend the app to the model when the app's divergence is an accident; bend the
model to the app only when the divergence is a decision.** Check for a comment
or a commit before assuming which. `life` was the first case — container `app`
under Deployment `life-app`, liveness 10/15 where `home` ran 15/20 — with
nothing explaining either. Preserving them would have meant widening the model
to encode an inconsistency, which is the opposite of what a model is for. Cost
of accepting: one pod restart, no config or data change.

## What stays out

Helm-based `cert-manager`, `ingress-nginx`, `mailu-mailserver` and `nextcloud`
are permanently out of scope: helm creates resources no manifest describes, so a
model cannot own them. They keep their own `sync.sh`. `vaultwarden` is out for
the different reason above — it would cost the invariants rather than being
unmodellable.

The prerequisite for all of this — one manifest layout across the fleet — landed
2026-07-27: every deployable lives under a `k8s/` directory, which is the shape
the renderer emits.
