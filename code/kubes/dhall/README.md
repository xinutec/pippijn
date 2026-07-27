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
| `lib/render.dhall` | `App` → Kubernetes resources |
| `lib/list.dhall` | `map`/`concatMap` (hand-written so no remote import is needed) |
| `dns.dhall` | every hostname the fleet serves |
| `apps/*.dhall` | one value per app — the part a human edits |
| `generate.sh` | render, or `--check` against the live tree |
| `normalize.py` | canonicalises YAML so `--check` compares meaning, not text |

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

Two apps are modelled. **`home` IS cut over** — `home/k8s/` is rendered output
(the files carry a GENERATED header) and `--check` reports `model matches the
live tree`. `generated/` is gitignored; the cut-over tree in `home/k8s/` is what
is committed and applied.

**`life` is modelled but NOT cut over**, blocked on three deliberate decisions
that `--check` reports:

| Live | Model | |
| --- | --- | --- |
| `initialDelaySeconds: 10`, `periodSeconds: 15` | `15` / `20` | changes restart behaviour |
| container `name: app` | `life-app` | renames a container → pod restart |
| Service `port: 3306` | adds `targetPort: 3306` | no-op; k8s defaults targetPort to port |

**Resolution: all three accepted, `life` cut over 2026-07-27.** The first
instinct was to bend the model back to life's values so the cutover would be a
behavioural no-op. Looking at what those values actually are killed that idea:
`home` — already cut over and live — runs one name throughout (Deployment
`home`, container `home`, Service `home`) and liveness 15/20. **`life` is the
outlier, not the model**: container `app` under Deployment `life-app`, liveness
10/15, with no comment or commit explaining either. They are accidents.

Preserving them would have meant adding per-app container-name and probe-timing
fields — widening the model to encode an inconsistency. That is the opposite of
what a model is for. The cost of accepting instead is one pod restart, no config
or data change, and life ends up matching home.

The rule this settles: **bend the app to the model when the app's divergence is
an accident; bend the model to the app only when the divergence is a decision.**
Check for a comment or a commit before assuming which.

## Where this is going

Six apps share the modelled skeleton (namespace + PVC + MariaDB + app + ingress
+ netpol): `coach`, `fleetwatch`, `health`, `home`, `life`, `nocodb`. Two are
modelled; the remaining four are the expansion targets. `signal` is a partial
fit (db + PVC, no ingress).

The prerequisite — one manifest layout across the fleet — landed 2026-07-27:
every deployable now lives under a `k8s/` directory, which is the shape the
renderer already emits. Apps outside the skeleton (helm-based `cert-manager`,
`ingress-nginx`, `mailu-mailserver`, `nextcloud`) are permanently out of scope:
helm creates resources no manifest describes, so a model cannot own them.
