{-
placed.dhall — the cluster each tree WITHOUT a model runs on, stated here so
`clusters.json` names every tree `plan-run deploy` can be asked about.

WHY. A modelled app's placement comes from its model (`apps/*.dhall`). These
trees have none: third-party charts' companions, and Nextcloud's hand-written
YAML. Their cluster used to live in three places: each `sync.sh` door's `--host`,
the deploy-drift collector's own list, and nowhere at all for nocodb. A tree
missing from all of them was drift-checked against the wrong cluster, where an
empty namespace reads like a first deploy (#692).

⚠ **AN ENTRY HERE IS A DEBT, NOT A DESIGN**, like `frontdoor-unowned.dhall`: the
end state for each tree is a model. `generate.sh` merges this with `∧`, so a tree
that gains a model and keeps its row here fails to evaluate.
-}
let T = ./lib/types.dhall

let R = ./lib/render.dhall

let on = λ(c : T.Cluster) → [ R.hostOf c ]

in  { `cert-manager` = on T.Cluster.amun
    , `ingress-nginx` = on T.Cluster.amun
    , `mailu-mailserver` = on T.Cluster.amun
    , nocodb = on T.Cluster.amun
    , nextcloud = on T.Cluster.isis
    }
