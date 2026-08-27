{-
`web` — the namespace the static sites live in, and the model's first subject
that is a NAMESPACE and nothing else.

⚠ **NOT A THIRD KIND — it sits in `apps/` like the other thirteen.** The draft
of this file assumed a namespace-only tree needed its own directory, glob and
render loop in `generate.sh`. It does not, and that assumption was the FOURTH
mis-sizing of this tree: `apps/*.dhall` already evaluate to `T.Namespace` (every
one ends `: T.Namespace`; `T.App` is a CONSTRUCTOR that `namespaceOf` lifts, and
every renderer takes the Namespace), and the app loop's live tree is
`$kubes/$app/k8s`, which `web/k8s/web.yaml` already matches.

⚠ **It is still not an `App`.** `T.App.workload` is required and rightly so: an
app that runs nothing is not an app. This tree runs nothing — it is one
`Namespace` object, created so that four sites owned by other trees have
somewhere to be. `S.Site` renders no Namespace precisely because THIS is what
renders it. So it is written as a literal `T.Namespace`, like `messages` and
`signal`, rather than through `namespaceOf`.

⚠ **AND IT IS THE FLEET'S FIRST MULTI-CLUSTER SUBJECT.** The same object is
applied to isis AND amun — verified 2026-08-26 by comparing
`kubectl.kubernetes.io/last-applied-configuration` on both, which are identical.
Before `T.Placement` the model could only say a subject lived on ONE cluster, so
this tree could not be described truthfully at all: modelling it would have
pinned it to one and made `plan-run deploy` REFUSE the other. That is why the
type came first and this file second.

⚠ **`labels` IS THE WHOLE OBJECT, so it cannot be dropped.** The live namespace
carries `name: web` and nothing else. `clusterMeta` rendered `labels = None`
unconditionally until this tree arrived, so `T.Labels` was added for it —
measured first: 13 of 13 modelled namespaces carry NO labels, and nothing
selects on this one, in-repo or in the live netpols on isis. It is modelled
rather than stripped because the model states what the fleet IS.

The sites that live here — `amun`, `isis`, `sinterklaas`, `slides` — are
`sites/*.dhall` and each declares `Owner.Elsewhere`. Their split across the two
clusters is why `web` spans both: two sites run on each.
-}

let T = ../lib/types.dhall

in  { name = "web"
    , owner = T.Owner.Own
    , labels = [ { mapKey = "name", mapValue = "web" } ]
    , placement = T.onBoth
    , db = None T.Database
    , configMap = None T.ConfigMapDoc
    , claims = [] : List T.Claim
    , -- Nothing runs here. The four sites are separate trees that declare
      -- `Owner.Elsewhere` and render their own workloads into this namespace.
      workloads = [] : List T.Workload.Type
    , secrets = [] : List T.SecretKey
    , -- ⚠ NOT a policy decision deferred — a namespace with no pods of its own
      -- has nothing to select. The sites' own trees carry their waivers; a
      -- policy here would target an empty pod set and read as protection.
      netpol = T.Netpol.Unpoliced
    , unowned = [] : List T.Unowned
    }
    : T.Namespace
