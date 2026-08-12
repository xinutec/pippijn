-- Minimal list helpers.
--
-- Deliberately hand-written rather than imported from the Dhall Prelude: a
-- remote import would make `dhall-to-yaml` need the network (and a frozen
-- hash) to render a manifest. Everything here is a builtin fold, so the whole
-- model stays evaluable offline.
let map
    : ∀(a : Type) → ∀(b : Type) → (a → b) → List a → List b
    = λ(a : Type) →
      λ(b : Type) →
      λ(f : a → b) →
      λ(xs : List a) →
        List/fold
          a
          xs
          (List b)
          (λ(x : a) → λ(acc : List b) → [ f x ] # acc)
          ([] : List b)

let concatMap
    : ∀(a : Type) → ∀(b : Type) → (a → List b) → List a → List b
    = λ(a : Type) →
      λ(b : Type) →
      λ(f : a → List b) →
      λ(xs : List a) →
        List/fold
          a
          xs
          (List b)
          (λ(x : a) → λ(acc : List b) → f x # acc)
          ([] : List b)

--| `None` for an empty list, `Some` otherwise.
--
-- `appDeployment` renders WITHOUT `--omit-empty` (see generate.sh), so an empty
-- list would serialise as `[]` instead of vanishing. This is how a field that
-- has nothing in it goes back to being absent — and, unlike the flag, it
-- distinguishes "nothing here" from "an empty thing that means something", which
-- is exactly what `emptyDir: {}` and `egress: []` needed.
let nonEmpty
    : ∀(a : Type) → List a → Optional (List a)
    = λ(a : Type) →
      λ(xs : List a) →
        if Natural/isZero (List/length a xs) then None (List a) else Some xs

in  { map, concatMap, nonEmpty }
