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

Two apps are modelled (`home`, `life`) and neither has been cut over — the live
`<app>/k8s/` trees are still authoritative and nothing here has been applied.
`generated/` is gitignored for that reason.

Cutting an app over means replacing its `k8s/` contents with the rendered
output and reviewing the diff `--check` reports as a deliberate change. See the
findings in the commit that introduced this directory: the model does not
currently reproduce the live tree byte for byte, and the differences are real.
