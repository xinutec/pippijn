{-
lib/manifests.dhall — which renderer's output lands in which file, in what
order, and which renderers must not have their empty values deleted.

WHY THIS IS NOT IN generate.sh ANY MORE. All three of these were bash: two
literal arrays and a `case` glob over renderer names, sitting beside a model that
states every other fact about these manifests in types. That is #65's complaint,
and of the three candidates it named — the waiver injectors, `--check`'s
comparison, and the per-renderer output flags — this is the part that could
actually move. The other two are measured and recorded at the bottom of this
comment, because "we looked and it cannot" is worth as much as the move.

⚠ ORDER IS LOAD-BEARING, AND THAT IS THE STRONGEST REASON THIS IS HERE. Within a
file the renderers are concatenated in the order below, and `doc_waiver` in
generate.sh anchors its DL-DEPLOY-BACKUP-COVERAGE marker on the LAST `---`
separator — because `01-pvc.yaml` renders the database's claim before the app's
own, and only the app's is being waived. So the awk depends on this list, the
list was in a different file from the model it describes, and a comment was the
only thing linking them. Reorder the pair below and the waiver silently lands on
a PVC that is backed up, which dev-lint then reports as a waiver waiving nothing.

⚠ `keepEmpty` IS NOT COSMETIC. `dhall-to-yaml-ng --omit-empty` deletes empty
values, and a default-deny NetworkPolicy is empty twice over: it selects the
whole namespace with `podSelector: {}` and denies a direction with an empty rule
list. With the flag on, dev-lint cannot RECOGNISE the policy — measured
2026-08-11 by rendering scanner and linting the result, which reported
`DL-K8S-NP-DEFAULT-DENY namespace scanner has no default-deny NetworkPolicy` on
a tree that had one. It is why `K.NetworkPolicy`'s rule lists are `Optional`:
with the flag off, "empty" and "absent" become expressible separately.

It was a glob — `netpol*|appDeployment` — which decided a dev-lint-visible
property by matching NAMES. A renderer added as `netpolExtra` would have
inherited the exception silently, and one that needed it under another name
would silently not get it. Stated per renderer, neither can happen quietly.

WHAT COULD NOT MOVE, measured 2026-08-17 rather than assumed:

  * The three waiver injectors. Their WHETHER and their WHY already come from
    the model (`R.storageWaiver`, `R.usesHostPort`, `R.hostPathWaiver`); what is
    left in shell is WHERE, and that is fixed by two things neither this file nor
    the model can reach. dev-lint's k8s engine scopes DL-K8S-HOST-PORT and
    DL-K8S-HOST-PATH to a LINE, so the marker must land on the flagged line
    itself; and `dhall-to-yaml-ng` cannot emit an inline comment at all. Its
    `--preserve-header` translates a Dhall comment header to a YAML one and
    `--generated-comment` emits a fixed do-not-edit warning — both above the
    document, which is exactly where a line-scoped waiver does nothing. So the
    injection is post-processing by construction, not by neglect.

  * `--check`'s comparison. It re-renders and diffs against the committed tree,
    which is lockfile discipline and the same thing `xinutec-infra`'s
    `plan/tables/render.sh` does deliberately. Not a defect to fix.

RENDERED, NOT PARSED. `manifestLines` and `keepEmptyRenderers` below emit the
exact text generate.sh already read, so the shell's parsing is unchanged and this
file is the only thing that moved. A renderer NAME is still Text that Dhall
cannot check against `render.dhall`'s record — there is no dynamic field access —
so a typo still fails at render time with `die_render`, as it did before. This
buys one source of truth and an explicit list; it does not buy name checking, and
saying otherwise would be the kind of claim this repository keeps catching.
-}

let L = ./list.dhall

{-| Keep the elements a predicate accepts.

    Hand-written rather than imported, like every other fold in this directory:
    the Prelude lives at a URL, and a remote import would make `dhall-to-yaml`
    need the network and a frozen hash to render a manifest. `lib/list.dhall`
    is deliberately minimal and shared, so a helper with one caller lives here.
-}
let filter
    : ∀(a : Type) → (a → Bool) → List a → List a
    = λ(a : Type) →
      λ(keep : a → Bool) →
      λ(xs : List a) →
        List/fold
          a
          xs
          (List a)
          (λ(x : a) → λ(acc : List a) → if keep x then [ x ] # acc else acc)
          ([] : List a)

let joinWith = L.joinWith

let Renderer = { name : Text, keepEmpty : Bool }

let names =
      λ(rs : List Renderer) → L.map Renderer Text (λ(r : Renderer) → r.name) rs

let Manifest = { file : Text, renderers : List Renderer }

let omit = λ(n : Text) → { name = n, keepEmpty = False }

let keep = λ(n : Text) → { name = n, keepEmpty = True }

let apps
    : List Manifest
    = [ { file = "00-namespace.yaml", renderers = [ omit "namespace" ] }
      , { file = "01-configmap.yaml", renderers = [ omit "configMap" ] }
      , { -- ⚠ The db's claim FIRST, the app's second. `doc_waiver` waives the
          -- LAST document in this file, and only the app's PVC is ever waived.
          file = "01-pvc.yaml"
        , renderers = [ omit "pvc", omit "appPvc" ]
        }
      , { file = "02-db.yaml"
        , renderers = [ omit "dbDeployment", omit "dbService" ]
        }
      , { file = "03-app.yaml"
        , renderers = [ keep "appDeployment", omit "appService" ]
        }
      , { file = "04-ingress.yaml", renderers = [ omit "ingress" ] }
      , { -- `keep`, because a cron's writable /tmp is an `emptyDir`, and an
          -- emptyDir IS an empty value: `--omit-empty` deleted the source and
          -- left `- name: tmp` alone. Kubernetes defaults a source-less volume
          -- to emptyDir, so nothing broke — measured 2026-08-25, server-side
          -- dry-run and the live objects both — but the manifest stopped saying
          -- what it meant and dev-lint reported six volumes with no source.
          file = "04-cronjobs.yaml"
        , renderers = [ keep "cronJobs" ]
        }
      , { file = "05-networkpolicy.yaml"
        , renderers = [ keep "netpolDb", keep "netpolApp" ]
        }
      , { file = "06-networkpolicy-app-held.yaml"
        , renderers = [ keep "netpolAppHeld" ]
        }
      ]

{-| The same, for the static sites under `web/org/xinutec/`.

    A separate list because a site is a different KIND of thing, not an app with
    fields switched off — see `lib/site.dhall`. It renders no Namespace: all four
    share `web`, which `kubes/web/k8s` owns, and a second copy of a shared object
    is how two trees start fighting over it.
-}
let sites
    : List Manifest
    = [ { file = "00-configmap.yaml", renderers = [ omit "configMaps" ] }
      , { file = "01-pvc.yaml", renderers = [ omit "pvc" ] }
      , { file = "02-deployment.yaml", renderers = [ omit "deployment" ] }
      , { file = "03-service.yaml", renderers = [ omit "service" ] }
      , { file = "04-ingress.yaml", renderers = [ omit "ingress" ] }
      , { file = "05-redirect.yaml", renderers = [ omit "redirect" ] }
      ]

{-| `<file>:<renderer> <renderer> …`, one line per file — the exact shape
    generate.sh's arrays held, so the shell's parsing did not have to change.
-}
let manifestLines
    : List Manifest → Text
    = λ(ms : List Manifest) →
        joinWith
          "\n"
          ( L.map
              Manifest
              Text
              (λ(m : Manifest) → "${m.file}:${joinWith " " (names m.renderers)}")
              ms
          )

{-| Every renderer, across both tables, whose empty values must survive — space
    separated, for a `[[ " $list " == *" $name "* ]]` membership test.

    Deliberately flat rather than per-file: the flag is a property of the
    RENDERER (what its output means when empty), and `03-app.yaml` holds one of
    each, so a per-file flag would be wrong there in a way nobody would notice
    until a default-deny went unrecognised.
-}
let keepEmptyRenderers
    : Text
    = joinWith
        " "
        ( names
            ( filter
                Renderer
                (λ(r : Renderer) → r.keepEmpty)
                ( L.concatMap
                    Manifest
                    Renderer
                    (λ(m : Manifest) → m.renderers)
                    (apps # sites)
                )
            )
        )

in  { Renderer
    , Manifest
    , apps
    , sites
    , appLines = manifestLines apps
    , siteLines = manifestLines sites
    , keepEmptyRenderers
    }
