{-
lib/secrets.dhall — every key each app's Secret must hold, and where each
value comes from, as DATA.

WHAT THIS IS FOR. Each app's `secret.sh` knew which keys to make, how (random,
composed, typed in) and which it could not make; the model knew only the key
names. This table says both, so `plan-run secrets` can read a cluster's Secret,
make the keys it can, and name the ones a person must give.

⚠ RENDERS NO MANIFEST BYTE, like `frontdoor.dhall`: evaluated into
`secrets.json` by `generate.sh` and read from there.

⚠ NO VALUE LIVES HERE. `literal` is the one field that carries one, and only
for a value that is not secret. The repository is public.

Dhall cannot compare two `Text`s, so the joins a reader wants — is this key
declared, is it read optionally — are rendered as the lists to join
(`declared`, `optionalKeys`) and made by the reader. `generate.sh` refuses a
table whose `declared` and `keys` name different sets.
-}
let Key =
      { key : Text
      , --| `generated`, `derived`, `literal`, `typed` or `shared`: the arm of
        --  `T.Origin`, flattened because a JSON reader cannot see a union's tag.
        kind : Text
      , bytes : Optional Natural
      , template : Optional Text
      , literal : Optional Text
      , --| Where a typed value comes from, or who holds a shared one.
        note : Optional Text
      }

let Entry =
      { app : Text
      , namespace : Text
      , secret : Text
      , --| The hosts whose cluster holds it, as `clusters.json` names them.
        clusters : List Text
      , --| The keys the app declares (`secrets = toMap keys`).
        declared : List Text
      , --| Keys some workload reads with `optional = True`: absent, a feature is
        --  off rather than a pod unable to start. A reader marks the key
        --  optional only when every declared key of that name is here.
        optionalKeys : List Text
      , --| One per declared key, from the app's `origins`.
        keys : List Key
      }

in  { Key, Entry }
