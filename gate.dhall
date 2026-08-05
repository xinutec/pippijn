{-
pippijn/gate.dhall — the monorepo's commit gate.

This repository had no gate at all until 2026-08-05, and the reason it had none
was a lint decision. `check` excluded it from the fleet outright because its ROOT
holds things that must never be linted — the personal dotfiles (`.reminders`,
`.gitconfig`) and the vendored `.nix-defexpr` channel checkout — and exclusion is
all-or-nothing: no lint, and therefore no gate either.

The cost of that was not hypothetical. `code/kubes/dhall/generate.sh --check`
compares the typed cluster model against the live `<app>/k8s/` trees. It is
correct, it is a genuine dry run (Dhall cannot perform IO), and nothing anywhere
ran it. When it was finally run by hand it was already red: home's manifest had
five environment variables hand-edited into it — the Nextcloud sign-in — in a
file whose own header says hand edits are overwritten. A render-then-apply would
have deleted them.

So membership was split instead: `LINT_EXEMPT` in `check` keeps the root out of
the linter while leaving this a member whose gate runs. The lint coverage that
matters is unchanged — `pippijn/code` and every `kubes/*` subdir are explicit
lint targets already.

There is deliberately no `dev-lint` row here, and it is the one gate in the fleet
without one. `check_gate_runs_devlint` exempts a `lint_exempt` member rather than
special-casing this file: a gate cannot be asked to lint a root the fleet has
decided not to lint.

The generated `gate.json` is committed; `the table matches its Dhall` re-renders
and diffs it, so running the gate needs no `dhall`.
-}

let G = ../dev-lint/gate/schema.dhall

in  { name = "pippijn"
    , checks =
      [ {-  The cluster model against the live manifests.

            Not `generate.sh` (write mode) followed by a diff: rendering is pure
            evaluation, so `--check` is a real dry run rather than a mode the
            renderer has to remember to honour — which is why this row can be
            trusted not to touch the tree it is judging.

            It compares each app's whole manifest SET rather than file by file,
            because the live trees number the same resources differently per app
            (home/05-ingress.yaml vs life/04-ingress.yaml) and the question worth
            answering is whether the model describes the same cluster, not
            whether it picked the same filenames.

            The script re-execs itself inside `code/kubes/dhall`'s own dev shell
            when `dhall-to-yaml-ng` is missing, so this row needs no shell of its
            own — the toolchain is pinned by that flake.lock.
        -}
        G.Check::{
        , name = "the cluster model matches the live manifests"
        , cwd = "code/kubes/dhall"
        , argv = [ "./generate.sh", "--check" ]
        , timeout_s = 900
        }
      , G.checkTable "../dev-lint"
      ]
    }
