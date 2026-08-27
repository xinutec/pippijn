let map
    : ∀(a : Type) → ∀(b : Type) → (a → b) → List a → List b
    =
      -- Minimal list helpers.
      --
      -- Deliberately hand-written rather than imported from the Dhall Prelude: a
      -- remote import would make `dhall-to-yaml` need the network (and a frozen
      -- hash) to render a manifest. Everything here is a builtin fold, so the whole
      -- model stays evaluable offline.
      λ(a : Type) →
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

let nonEmpty
    : ∀(a : Type) → List a → Optional (List a)
    = λ(a : Type) →
      λ(xs : List a) →
        if Natural/isZero (List/length a xs) then None (List a) else Some xs

{-| Join with a separator BETWEEN elements — no leading or trailing one, which a
    naive fold produces and which would give the shell an empty first or last
    record to parse.

    Shared rather than local since `manifests.dhall` and `render.dhall` both
    need it. `manifests.dhall` had it privately first, with a note saying a
    helper with one caller lives beside its caller; the second caller is what
    moved it.
-}
let joinWith
    : Text → List Text → Text
    = λ(sep : Text) →
      λ(xs : List Text) →
        merge
          { None = "", Some = λ(s : Text) → s }
          ( List/fold
              Text
              xs
              (Optional Text)
              ( λ(x : Text) →
                λ(acc : Optional Text) →
                  merge
                    { None = Some x
                    , Some = λ(rest : Text) → Some "${x}${sep}${rest}"
                    }
                    acc
              )
              (None Text)
          )

in  { map, concatMap, nonEmpty, joinWith }
