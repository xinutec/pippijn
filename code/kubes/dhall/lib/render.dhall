-- App → Kubernetes resources.
--
-- Every renderer returns a *list* of resources (usually 0 or 1). That is how
-- optionality is expressed without an escape hatch: an app with no database
-- renders an empty list, `dhall-to-yaml-ng --documents` emits nothing, and no
-- shell conditional decides whether a file should exist.
--
-- All naming is derived, never passed in. A Service selector cannot disagree
-- with its pod labels, an Ingress cannot point at a Service that was renamed,
-- and a secretKeyRef cannot name another app's Secret, because in each case
-- there is exactly one expression producing the string.
let T = ./types.dhall

let K = ./k8s.dhall

let L = ./list.dhall

--| The fleet's MariaDB. Bumping this line bumps every database at once, which
--  is the entire reason it is a line and not a copy-pasted image string.
--
--  MariaDB has no downgrade path — dump before changing it:
--    scripts/mariadb-major-upgrade.sh before <app> <db>   (then after)
let mariadbVersion = "12.3"

let Annotations = List { mapKey : Text, mapValue : Text }

--| Whether the app has a database, and therefore whether the namespace's FIRST
--  Deployment is the database's or the app's. The generator needs this to place
--  the DL-K8S-NP-DEFAULT-DENY waiver, which dev-lint anchors on that first
--  Deployment; it cannot come from the rendered YAML because a waiver is a
--  comment and rendering drops comments.
--
--  Asked of the model rather than inferred from which manifests come back
--  non-empty: the inference happened to work only because `manifests` in
--  generate.sh is ordered db-before-app, so reordering that list would have
--  silently moved the waiver onto the wrong file. Here it is a total function of
--  the model, checked by the typechecker.
--| Does this app render a NetworkPolicy the cluster will actually APPLY?
--
-- Asked by `generate.sh` to decide whether to emit the `allow-no-netpol`
-- waiver. dev-lint fails a waiver that waives nothing, so an app with a real
-- default-deny must NOT carry one — and the answer has to come from the model
-- rather than from a list in the generator, which is the shape that let
-- utterance go unwaived for months.
--
-- `IngressFromNginx` counts as NO: it renders to a `-held.yaml` that is
-- deliberately outside the applied set, so the namespace is still undefended
-- and the waiver is still the honest record.
--
-- ⚠ A namespace owned ELSEWHERE also counts as YES, and this is the second half
-- of `T.Owner`'s point rather than a special case bolted on. `messages` renders
-- no policy — its egress rule is declared in signal's tree, where the namespace's
-- policies live — but the namespace it runs in has a default-deny all the same.
-- Asking only `ns.netpol` would read `Unpoliced` and emit a waiver for a
-- namespace that IS defended, which dev-lint fails as ineffective, correctly.
let hasAppliedNetpol
    : T.Namespace → Bool
    = λ(ns : T.Namespace) →
        merge
          { Own =
              merge
                { Unpoliced = False
                , IngressFromNginx = False
                , Egress = λ(_ : List T.EgressTo) → True
                , Policies = λ(_ : List T.NetpolPolicy) → True
                }
                ns.netpol
          , Elsewhere =
              λ(_ : { tree : Text, slug : Text, ingressName : Text }) → True
          }
          ns.owner

--| Does this app's Deployment carry a `hostPort`?
--
-- Asked by `generate.sh` to decide whether to emit the `allow-host-port` waiver.
-- `WireGuard` is the only arm that renders one, and it always does — the hostPort
-- pinned to the tunnel address IS how such an app is reached, so the question is
-- answered by the reach and never per-ns.
--
-- Same discipline as `hasAppliedNetpol`: dev-lint fails a waiver that waives
-- nothing, so this must be the model's answer rather than a list in the
-- generator that a new app can be missing from.
let usesHostPort
    : T.Namespace → Bool
    = λ(ns : T.Namespace) →
        List/fold
          T.Workload
          ns.workloads
          Bool
          ( λ(w : T.Workload) →
            λ(acc : Bool) →
                  merge
                    { Ingress =
                        λ(_ : { host : Text, exposure : T.Exposure }) → False
                    , WireGuard = True
                    , HostPorts = λ(_ : { published : List T.Published, why : Text }) → True
                    , Internal = False
                    , NoService = False
                    }
                    w.reach
              ||  acc
          )
          False

let hasDb
    : T.Namespace → Bool
    = λ(ns : T.Namespace) →
        merge { None = False, Some = λ(_ : T.Database) → True } ns.db

--| The host this app must deploy to. The cluster has been a field on `T.App`
--  since the model existed; until 2026-08-10 nothing read it, and the deploy
--  tool asked whoever was typing instead. Rendered into `dhall/clusters.json`
--  and read by `plan-run deploy`, which refuses a `--host` that contradicts it.
--  See `site.dhall`'s twin.
--  ⚠ Returns a LIST since 2026-08-26: a subject may be placed on more than one
--  cluster (`web` is, on both), and `plan-run deploy` runs its one-host plan
--  once per host rather than learning about two.
let hostOf
    : T.Cluster → Text
    = λ(c : T.Cluster) →
        merge { isis = "isis.xinutec.org", amun = "amun.xinutec.org" } c

let clusterHosts
    : T.Namespace → List Text
    = λ(ns : T.Namespace) →
        L.map T.Cluster Text hostOf (T.placedOn ns.placement)

--| `T.Resources` → the API's shape.
--
-- These stopped being the same record once `T.Limits` made `cpu` Optional and
-- kept `memory` required, so this is the one place the fleet's policy meets the
-- API's permissiveness. `Some` on the way out: a memory limit that `T.Limits`
-- required cannot go missing here.
let k8sResources
    : T.Resources → K.Resources
    = λ(r : T.Resources) →
          r.{ requests }
        ⫽ { limits =
              merge
                { None = None K.Limits
                , Some =
                    λ(l : T.Limits) → Some { cpu = l.cpu, memory = Some l.memory }
                }
                r.limits
          }

--| The declared-unowned filenames, one per line, for the generator's `--check`.
--
-- A `List/fold` rather than a Prelude import, and `site.dhall`'s twin says why:
-- this directory vendors the two list helpers it needs instead of pulling a
-- package over the network, so that rendering never depends on being online.
--
-- Empty for every tree that owns all of its manifests, which is thirteen of
-- them. `--check` excludes exactly these files and nothing else, so a manifest
-- appearing in a live tree without a line here is still a failure.
let unownedFiles
    : T.Namespace → Text
    = λ(ns : T.Namespace) →
        List/fold
          T.Unowned
          ns.unowned
          Text
          ( λ(u : T.Unowned) →
            λ(acc : Text) →
              ''
              ${u.file}
              ${acc}''
          )
          ""

--| The name every object in this tree is named AFTER.
--
-- ⚠ NOT `ns.name`, and the difference is the whole of `T.Owner`. For thirteen of
-- fourteen trees the two coincide and this is the identity; for `messages` they
-- do not, and `secretNameFor ns.name` would ask a pod in the `signal` namespace
-- to read `signal-secret` for its OWN session keys.
--
-- Every derivation below goes through this, including the database and claim
-- names that no `Elsewhere` tree currently uses. That is deliberate: a second
-- one, with a database of its own, would otherwise render `signal-db` into a
-- namespace that already has a `signal-db`, and the collision would appear as
-- one Service selecting two different pods. Closing it now costs nothing —
-- `Own` makes every one of these the identity — and it cannot be closed later by
-- anyone who has not just read this comment.
--
-- `ns.name` survives in exactly one role: the namespace a resource lives IN,
-- which is `meta`'s second argument.
let slugOf
    : T.Namespace → Text
    = λ(ns : T.Namespace) →
        merge
          { Own = ns.name
          , Elsewhere =
              λ(o : { tree : Text, slug : Text, ingressName : Text }) → o.slug
          }
          ns.owner

--| The Ingress object's own name. Derived where the tree owns its namespace,
--  stated where it does not — see `T.Owner.Elsewhere.ingressName` for why an
--  Ingress name is not free to change.
let ingressNameOf
    : T.Namespace → Text
    = λ(ns : T.Namespace) →
        merge
          { Own = "${ns.name}-ingress"
          , Elsewhere =
              λ(o : { tree : Text, slug : Text, ingressName : Text }) →
                o.ingressName
          }
          ns.owner

-- Keyed on the NAMESPACE NAME rather than on an `App`, because both `T.App` and
-- `T.Namespace` need them and Dhall has no subtyping — a function taking one
-- record type will not accept a wider one. The `App`-shaped versions below are
-- the same expressions, so the derivation stays single-sourced.
let secretNameFor = λ(name : Text) → "${name}-secret"

let dbNameFor = λ(name : Text) → "${name}-db"

let pvcNameFor = λ(name : Text) → "${name}-db-pvc"

let dataPvcNameFor = λ(name : Text) → "${name}-data-pvc"

let secretName = λ(ns : T.Namespace) → secretNameFor (slugOf ns)

let dbName = λ(ns : T.Namespace) → dbNameFor (slugOf ns)

let pvcName = λ(ns : T.Namespace) → pvcNameFor (slugOf ns)

let dataPvcName = λ(ns : T.Namespace) → dataPvcNameFor (slugOf ns)

--| The pod-local name of the app's own volume. Distinct from the database's
--  `data` volume, which lives in a different pod entirely.
let dataVolumeName = "app-data"

--| The labels an app's pod template, Service and policies all select on. One
--  expression, so a Service selector cannot disagree with what it selects.
let appLabels
    : Text → K.Labels
    = λ(name : Text) → toMap { app = name }

--| A workload's own pod labels, which ARE its Deployment's immutable selector.
--
-- `appLabels` stays for everything GENERATED — the db Deployment, its Service,
-- its policy — where `app:` is the only convention and no live object predates
-- the model. This exists because `ircd` and both irssi namespaces select `run:`.
let workloadLabels
    : T.Selector → Text → K.Labels
    = λ(s : T.Selector) →
      λ(name : Text) →
        merge { App = toMap { app = name }, Run = toMap { run = name } } s

let meta
    : Text → Text → K.Meta
    = λ(name : Text) →
      λ(ns : Text) →
        { name
        , namespace = Some ns
        , annotations = None Annotations
        , labels = None Annotations
        }

let clusterMeta
    : Text → T.Labels → K.Meta
    = λ(name : Text) →
      λ(labels : T.Labels) →
        { name
        , namespace = None Text
        , annotations = None Annotations
        , -- ⚠ EMPTY MAPS TO ABSENT, not to `Some []`. `labels: {}` is a
          -- different manifest from no labels at all, and 13 of the 14 trees
          -- carry none — rendering an empty map would change every one of them.
          labels =
            if    Natural/isZero (List/length { mapKey : Text, mapValue : Text } labels)
            then  None Annotations
            else  Some labels
        }

let renderEnv
    : Text → T.EnvVar → K.EnvVar
    = λ(secret : Text) →
      λ(e : T.EnvVar) →
        merge
          { Literal =
              λ(v : Text) →
                { name = e.name
                , value = Some v
                , valueFrom = None { secretKeyRef : K.SecretKeyRef }
                }
          , FromSecret =
              λ(s : { key : Text, optional : Bool }) →
                { name = e.name
                , value = None Text
                , valueFrom = Some
                  { secretKeyRef =
                    { name = secret
                    , key = s.key
                    , optional = if s.optional then Some True else None Bool
                    }
                  }
                }
          , FromUnmanagedSecret =
              λ(s : { secret : Text, key : Text, optional : Bool }) →
                { name = e.name
                , value = None Text
                , valueFrom = Some
                  { secretKeyRef =
                    { name = s.secret
                    , key = s.key
                    , optional = if s.optional then Some True else None Bool
                    }
                  }
                }
          }
          e.value

let renderProbe
    : T.Probe → Optional K.Probe
    = λ(p : T.Probe) →
        merge
          { Http =
              λ(h : K.HTTPGetAction) → Some (K.emptyProbe ⫽ { httpGet = Some h })
          , Exec = λ(e : K.ExecAction) → Some (K.emptyProbe ⫽ { exec = Some e })
          , Tcp =
              λ(t : K.TCPSocketAction) →
                Some (K.emptyProbe ⫽ { tcpSocket = Some t })
          , -- Nothing to probe: renders neither key rather than an empty probe.
            Unprobed = None K.Probe
          }
          p

let execProbe
    : List Text → K.Probe
    = λ(cmd : List Text) → K.emptyProbe ⫽ { exec = Some { command = cmd } }

--| A container with every optional field switched off; renderers override the
--  parts they mean. Keeps each container literal to what is actually specific
--  about it.
let baseContainer =
      { command = None (List Text)
      , args = None (List Text)
      , imagePullPolicy = None Text
      , ports = None (List K.ContainerPort)
      , env = None (List K.EnvVar)
      , volumeMounts = None (List K.VolumeMount)
      , startupProbe = None K.Probe
      , livenessProbe = None K.Probe
      , readinessProbe = None K.Probe
      }

--| A declared mount, widened to the API shape. `T.VolumeMount` keeps `subPath`
--  required because every mount the fleet declares has one; the API field is
--  optional, and the sites use it both ways.
let k8sMount
    : T.VolumeMount → K.VolumeMount
    = λ(m : T.VolumeMount) →
        { name = m.name
        , mountPath = m.mountPath
        , subPath = m.subPath
        , -- Absent rather than `false`, so a mount that is writable renders the
          -- same as every mount rendered before this field existed.
          readOnly = if m.readOnly then Some True else None Bool
        }

--| One declared volume as the API wants it: exactly one source key set, the
--  other three absent. `T.VolumeSource` is what makes "exactly one" true; this
--  only widens it.
let k8sVolume
    : T.Volume → K.Volume
    = λ(v : T.Volume) →
        let empty =
              { name = v.name
              , persistentVolumeClaim = None { claimName : Text }
              , configMap = None { name : Text }
              , emptyDir = None {}
              , hostPath = None { path : Text, type : Text }
              , secret =
                  None { secretName : Text, defaultMode : Optional Natural }
              }

        in  merge
              { EmptyDir = empty ⫽ { emptyDir = Some {=} }
              , ConfigMap =
                  λ(c : { name : Text }) → empty ⫽ { configMap = Some c }
              , HostPath =
                  λ(h : { path : Text, why : Text }) →
                      empty
                    ⫽ { hostPath = Some { path = h.path, type = "Directory" } }
              , Claim =
                  λ(c : T.Claim) →
                      empty
                    ⫽ { persistentVolumeClaim = Some { claimName = c.name } }
              , Secret =
                  λ(s : { name : Text, mode : Optional Natural }) →
                      empty
                    ⫽ { secret = Some
                        { secretName = s.name, defaultMode = s.mode }
                      }
              }
              v.source

let mountedClaims
    : T.Workload → List T.Claim
    = λ(w : T.Workload) →
        L.concatMap
          T.Volume
          T.Claim
          ( λ(v : T.Volume) →
              merge
                { EmptyDir = [] : List T.Claim
                , ConfigMap = λ(_ : { name : Text }) → [] : List T.Claim
                , HostPath =
                    λ(_ : { path : Text, why : Text }) → [] : List T.Claim
                , Claim = λ(c : T.Claim) → [ c ]
                , Secret =
                    λ(_ : { name : Text, mode : Optional Natural }) →
                      [] : List T.Claim
                }
                v.source
          )
          w.volumes

let anyClaim
    : T.Workload → Bool
    = λ(w : T.Workload) →
        Natural/isZero (List/length T.Claim (mountedClaims w)) == False

--| The namespace's ONE workload, when it has exactly one.
--
-- `netpolDb` names a workload in its selector, which is only meaningful when
-- there is one to name. With several — or with batch tasks, whose pods carry
-- only per-run labels — the honest selector is the whole namespace.
let soleWorkload
    : T.Namespace → Optional T.Workload
    = λ(ns : T.Namespace) →
        let len = List/length T.Workload ns.workloads

        in  if        Natural/isZero (Natural/subtract 1 len)
                  &&  (if Natural/isZero len then False else True)
            then  List/head T.Workload ns.workloads
            else  None T.Workload

--| `Unhardened` drops the three identity fields and keeps everything else —
--  `fsGroup` and seccomp still apply, which is as far as such a pod can be
--  hardened. See `T.Hardening`.
let podSecurityContext
    : Natural → Optional Natural → T.Hardening → K.PodSecurityContext
    = λ(uid : Natural) →
      λ(fsGroup : Optional Natural) →
      λ(h : T.Hardening) →
        let identity =
              merge
                { NonRoot =
                  { runAsNonRoot = Some True
                  , runAsUser = Some uid
                  , runAsGroup = Some uid
                  }
                , Unhardened =
                    λ(_ : { why : Text }) →
                      { runAsNonRoot = None Bool
                      , runAsUser = None Natural
                      , runAsGroup = None Natural
                      }
                }
                h

        in    identity
            ⫽ { fsGroup
              , fsGroupChangePolicy = None Text
              , seccompProfile.type = "RuntimeDefault"
              }

let containerSecurityContext
    : T.RootFs → K.ContainerSecurityContext
    = λ(rootFs : T.RootFs) →
        { allowPrivilegeEscalation = False
        , -- `None` rather than `Some False` under `Writable`: the field's absence
          -- IS the writable state in Kubernetes, and emitting the explicit false
          -- would change every generated manifest to say the same thing louder.
          -- The `why` does not appear here at all — it leaves through
          -- `containerWaivers`, because YAML rendered from Dhall cannot carry a
          -- comment.
          readOnlyRootFilesystem =
            merge
              { ReadOnly = Some True
              , Writable = λ(_ : { why : Text }) → None Bool
              }
              rootFs
        , capabilities.drop = [ "ALL" ]
        }

--| The Namespace object — rendered only by the tree that owns it.
--
-- An empty list where it does not, which is the same "renderer opts out" shape
-- as `pvc` and `configMap`: no document, so `generate.sh` writes no file and
-- there is no `00-namespace.yaml` to disagree with signal's.
let namespace
    : T.Namespace → List K.Namespace
    = λ(ns : T.Namespace) →
        merge
          { Own =
            [ { apiVersion = "v1"
              , kind = "Namespace"
              , metadata = clusterMeta ns.name ns.labels
              }
            ]
          , Elsewhere =
              λ(_ : { tree : Text, slug : Text, ingressName : Text }) →
                [] : List K.Namespace
          }
          ns.owner

--| The app's own ConfigMap, if it declares one.
--
-- A list rather than an Optional so the generator concatenates it like every
-- other renderer: an app with no ConfigMap renders no document, and the file is
-- simply not written. Same shape as `pvc`, for the same reason.
let configMap
    : T.Namespace → List K.ConfigMap
    = λ(ns : T.Namespace) →
        merge
          { None = [] : List K.ConfigMap
          , Some =
              λ(cm : T.ConfigMapDoc) →
                [ { apiVersion = "v1"
                  , kind = "ConfigMap"
                  , metadata = meta cm.name ns.name
                  , data = cm.files
                  }
                ]
          }
          ns.configMap

--| The backup-coverage waiver an app's own claim should carry, or "" for none.
--
-- Empty means "no waiver": either the app has no volume of its own, or it
-- declared `BackedUp` and must genuinely appear in backup-prepare.sh — dev-lint
-- checks that join across the fleet, so the claim cannot be merely asserted.
--
-- The generator used to hold this as a hardcoded case for one ns. Moving it
-- into the model means a second app cannot be added without answering the
-- question, and the answer sits beside the volume it describes rather than in a
-- shell `case` far away from it.
let storageWaiver
    : T.Namespace → Text
    = λ(ns : T.Namespace) →
        List/fold
          T.Claim
          ns.claims
          Text
          ( λ(c : T.Claim) →
            λ(acc : Text) →
                  merge
                    { BackedUp = ""
                    , LossAccepted = λ(r : { why : Text }) → r.why
                    }
                    c.durability
              ++  acc
          )
          ""

--| The `allow-host-path` justification an app's volumes need, or "" for none.
--
-- Same discipline as `storageWaiver`: the model answers WHETHER and WHY, and the
-- generator holds only the marker syntax. A list of host-path apps in the shell
-- is the shape that let utterance go unwaived for months.
--
-- The FIRST `why` wins, and that is a real limit rather than an oversight: the
-- marker is line-scoped, so a second host-path volume would need its own marker
-- on its own line. No app has two, and `--check` fails loudly if one appears —
-- the rendered tree would carry a finding the live tree waives.
let hostPathWaiver
    : T.Namespace → Text
    = λ(ns : T.Namespace) →
        merge
          { None = "", Some = λ(why : Text) → why }
          ( List/head
              Text
              ( L.concatMap
                  T.Volume
                  Text
                  ( λ(v : T.Volume) →
                      merge
                        { EmptyDir = [] : List Text
                        , ConfigMap = λ(_ : { name : Text }) → [] : List Text
                        , HostPath =
                            λ(h : { path : Text, why : Text }) → [ h.why ]
                        , Claim = λ(_ : T.Claim) → [] : List Text
                        , Secret =
                            λ(_ : { name : Text, mode : Optional Natural }) →
                              [] : List Text
                        }
                        v.source
                  )
                  ( L.concatMap
                      T.Workload
                      T.Volume
                      (λ(w : T.Workload) → w.volumes)
                      ns.workloads
                  )
              )
          )

--| Per-CONTAINER dev-lint waivers, one per line: `name<TAB>suffix<TAB>why`.
--
-- The fourth injector, and the one the model was carrying blind. DL-K8S-ROOTFS-RW
-- and DL-K8S-NO-PROBE are LINE-scoped — dev-lint anchors them on the container's
-- first line — so a file-level marker would waive every container in the file,
-- including the ones that never fired. `03-app.yaml` holds three, and only two of
-- them are writable; over-waiving there is precisely how a rule stops meaning
-- anything.
--
-- So the model answers WHICH CONTAINER and WHY, and `generate.sh` holds only the
-- placement — the same division as `hostPathWaiver` and `storageWaiver`.
--
-- ⚠ TASKS TOO, and they are the half that is easy to forget. A CronJob container
-- fires ROOTFS-RW in a different FILE from the workload it is declared under, so
-- emitting only the workloads left `signal-irclog-import` unwaived. It states
-- its own reason (`T.ScheduledTask.rootFs`) rather than inheriting one, because
-- the first task to need this had a reason that was not its workload's.
--
-- `no-probe` carries no `why` because `T.Probe.Unprobed` is not a Bool — the
-- constructor already says "there is nothing to probe", and its note explains
-- what would justify giving it a payload (a second probeless workload; there is
-- still one).
let containerWaivers
    : T.Namespace → Text
    = λ(ns : T.Namespace) →
        {-  ⚠ ONLY FOR AN IMAGE THE FLEET BUILDS, and this is a judgement call
            worth reading before changing. dev-lint's `image_profile` switches
            DL-K8S-ROOTFS-RW OFF for a list of third-party images —
            `signal-cli-rest-api`, `nextcloud`, `nginx`, `inspircd`, every
            `-db` — so a marker on one of those waives NOTHING and the linter
            reports it as ineffective, which is a finding in its own right.

            The model cannot mirror that substring list, and copying it here
            would be a second copy of somebody else's rule: the thing this
            fleet keeps learning not to build. `T.Image.Fleet` is a DIFFERENT
            question — do we build this? — that happens to line up, because
            every carve-out on that list is there for the same reason ("a
            third-party filesystem is not ours to constrain").

            Where the two disagree it fails in the SAFE direction: a
            third-party image not on dev-lint's list gets no waiver and its
            finding shows up, rather than being quietly suppressed.
        -}
        let lineFor =
              λ(image : T.Image) →
              λ(name : Text) →
              λ(rootFs : T.RootFs) →
                merge
                  { Fleet =
                      λ(_ : Text) →
                        merge
                          { ReadOnly = [] : List Text
                          , Writable =
                              λ(r : { why : Text }) →
                                [ "${name}\trootfs-rw\t${r.why}" ]
                          }
                          rootFs
                  , Upstream =
                      λ(_ : { repo : Text, tag : Text }) → [] : List Text
                  , Local = λ(_ : Text) → [] : List Text
                  }
                  image

        let rootFsLines =
              λ(w : T.Workload) →
                  lineFor w.image w.name w.rootFs
                # L.concatMap
                    T.ScheduledTask
                    Text
                    (λ(t : T.ScheduledTask) → lineFor w.image t.name t.rootFs)
                    w.tasks

        let probeLines =
              λ(w : T.Workload) →
                merge
                  { Http = λ(_ : { path : Text, port : Natural }) → [] : List Text
                  , Exec = λ(_ : { command : List Text }) → [] : List Text
                  , Tcp = λ(_ : { port : Natural }) → [] : List Text
                  , Unprobed = [ "${w.name}\tno-probe\t" ]
                  }
                  w.probe

        in  L.joinWith
              "\n"
              ( L.concatMap
                  T.Workload
                  Text
                  (λ(w : T.Workload) → rootFsLines w # probeLines w)
                  ns.workloads
              )

--| Why this app's Deployment file carries an `allow-unhardened`, "" for none.
--
-- FILE-scoped in dev-lint's registry, unlike the two above, so this goes in
-- `header()` rather than beside a container. That is a looser instrument than
-- the rule deserves — it covers every container in the file — and it is what
-- dev-lint offers; the marker is only ever emitted when the model says at least
-- one workload here is `Unhardened`, so it cannot be a blanket nobody asked for.
--
-- Joined rather than first-of, for the day a second one appears: a waiver
-- speaking for two containers must say both reasons, and silently keeping one
-- would make the other look reviewed.
let unhardenedWaiver
    : T.Namespace → Text
    = λ(ns : T.Namespace) →
        L.joinWith
          "; "
          ( L.concatMap
              T.Workload
              Text
              ( λ(w : T.Workload) →
                  merge
                    { NonRoot = [] : List Text
                    , Unhardened = λ(u : { why : Text }) → [ u.why ]
                    }
                    w.hardening
              )
              ns.workloads
          )

let pvc
    : T.Namespace → List K.PersistentVolumeClaim
    = λ(ns : T.Namespace) →
        merge
          { Some =
              λ(d : T.Database) →
                [ { apiVersion = "v1"
                  , kind = "PersistentVolumeClaim"
                  , metadata = meta (pvcNameFor (slugOf ns)) ns.name
                  , spec =
                    { accessModes = [ "ReadWriteOnce" ]
                    , resources.requests.storage
                      = "${Natural/show d.storageGi}Gi"
                    }
                  }
                ]
          , None = [] : List K.PersistentVolumeClaim
          }
          ns.db

let claimPvcs
    : T.Namespace → List K.PersistentVolumeClaim
    = λ(ns : T.Namespace) →
        L.map
          T.Claim
          K.PersistentVolumeClaim
          ( λ(c : T.Claim) →
              { apiVersion = "v1"
              , kind = "PersistentVolumeClaim"
              , metadata = meta c.name ns.name
              , spec =
                { accessModes = [ "ReadWriteOnce" ]
                , resources.requests.storage = "${Natural/show c.storageGi}Gi"
                }
              }
          )
          ns.claims

--| The claim behind [`T.Storage`], if the app declared one.
--
-- Rendered into the same file as the database's claim, so `01-pvc.yaml` is
-- every piece of durable state a namespace owns rather than only the half that
-- happens to be a database.
let appPvc = claimPvcs

let dbDeployment
    : T.Namespace → List K.Deployment
    = λ(ns : T.Namespace) →
        merge
          { Some =
              λ(d : T.Database) →
                [ { apiVersion = "apps/v1"
                  , kind = "Deployment"
                  , metadata = meta (dbNameFor (slugOf ns)) ns.name
                  , spec =
                    { replicas = 1
                    , -- Single RWO PVC: never run two DB pods at once.
                      strategy = Some
                      { type = "Recreate" }
                    , selector.matchLabels = appLabels (dbNameFor (slugOf ns))
                    , template =
                      { metadata.labels = appLabels (dbNameFor (slugOf ns))
                      , spec =
                        { -- The official image runs as uid 999 (mysql) when
                          -- started unprivileged; fsGroup keeps the data dir
                          -- writable.
                          securityContext = podSecurityContext 999 (Some 999) T.Hardening.NonRoot
                        , restartPolicy = None Text
                        , containers =
                          [   baseContainer
                            ⫽ { name = "mariadb"
                              , image = "mariadb:${mariadbVersion}"
                              , -- Server flags to the image's own entrypoint.
                                -- The pool is stated in GiB and rendered in
                                -- bytes, because the flag takes bytes and a
                                -- hand-written 2147483648 is a number nobody
                                -- can check by reading.
                                args =
                                  merge
                                    { None = None (List Text)
                                    , Some =
                                        λ(gi : Natural) →
                                          Some
                                            [ "--innodb-buffer-pool-size=${Natural/show
                                                                             (   gi
                                                                               * 1024
                                                                               * 1024
                                                                               * 1024
                                                                             )}"
                                            ]
                                    }
                                    d.innodbBufferPoolGi
                              , -- mariadbd writes /run/mysqld and its data dir.
                                --
                                -- ⚠ No `containerWaivers` line comes out of
                                -- this, and that is right rather than an
                                -- omission: dev-lint's `image_profile` carves
                                -- every `is_db` container out of
                                -- DL-K8S-ROOTFS-RW, so a marker here would waive
                                -- nothing and be reported as ineffective. If
                                -- that carve-out ever goes, six databases fire
                                -- at once and say so.
                                securityContext =
                                  Some
                                    ( containerSecurityContext
                                        ( T.RootFs.Writable
                                            { why =
                                                "mariadbd writes /run/mysqld and its data directory"
                                            }
                                        )
                                    )
                              , env = Some
                                  ( L.map
                                      T.EnvVar
                                      K.EnvVar
                                      (renderEnv (secretNameFor (slugOf ns)))
                                      [ { name = "MARIADB_AUTO_UPGRADE"
                                        , -- Migrate system tables on first start
                                          -- after a major bump.
                                          value = T.EnvValue.Literal "1"
                                        }
                                      , { name = "MARIADB_DATABASE"
                                        , value = T.EnvValue.Literal d.dbName
                                        }
                                      , { name = "MARIADB_USER"
                                        , value =
                                            T.EnvValue.FromSecret
                                              { key = d.keys.user
                                              , optional = False
                                              }
                                        }
                                      , { name = "MARIADB_PASSWORD"
                                        , value =
                                            T.EnvValue.FromSecret
                                              { key = d.keys.password
                                              , optional = False
                                              }
                                        }
                                      , { name = "MARIADB_ROOT_PASSWORD"
                                        , value =
                                            T.EnvValue.FromSecret
                                              { key = d.keys.rootPassword
                                              , optional = False
                                              }
                                        }
                                      ]
                                  )
                              , ports = Some
                                [ { containerPort = 3306
                                  , hostPort = None Natural
                                  , hostIP = None Text
                                  }
                                ]
                              , volumeMounts = Some
                                [ { name = "data"
                                  , mountPath = "/var/lib/mysql"
                                  , subPath = Some "mariadb-data"
                                  , readOnly = None Bool
                                  }
                                ]
                              , -- startupProbe holds liveness off until the
                                -- server accepts connections, so a major-version
                                -- MARIADB_AUTO_UPGRADE (start→upgrade→shutdown→
                                -- restart) cannot be SIGKILLed mid-run the way
                                -- health-db and life-db were on 2026-07-22/23.
                                startupProbe = Some
                                  (   execProbe
                                        [ "healthcheck.sh", "--connect" ]
                                    ⫽ { periodSeconds = Some 10
                                      , failureThreshold = Some 60
                                      , timeoutSeconds = Some 5
                                      }
                                  )
                              , livenessProbe = Some
                                  (   execProbe
                                        [ "healthcheck.sh"
                                        , "--connect"
                                        , "--innodb_initialized"
                                        ]
                                    ⫽ { initialDelaySeconds = Some 30
                                      , periodSeconds = Some 10
                                      , -- a busy server can miss an implicit 1s
                                        -- and get killed for being slow
                                        timeoutSeconds = Some
                                          5
                                      }
                                  )
                              , readinessProbe = Some
                                  (   execProbe
                                        [ "healthcheck.sh", "--connect" ]
                                    ⫽ { initialDelaySeconds = Some 10
                                      , periodSeconds = Some 5
                                      }
                                  )
                              , resources = Some (k8sResources d.resources)
                              }
                          ]
                        , volumes = Some
                          [ { name = "data"
                            , persistentVolumeClaim = Some
                              { claimName = pvcNameFor (slugOf ns) }
                            , configMap = None { name : Text }
                            , emptyDir = None {}
                            , hostPath = None { path : Text, type : Text }
                            , secret =
                                None
                                  { secretName : Text
                                  , defaultMode : Optional Natural
                                  }
                            }
                          ]
                        }
                      }
                    }
                  }
                ]
          , None = [] : List K.Deployment
          }
          ns.db

let dbService
    : T.Namespace → List K.Service
    = λ(ns : T.Namespace) →
        merge
          { Some =
              λ(_ : T.Database) →
                [ { apiVersion = "v1"
                  , kind = "Service"
                  , metadata = meta (dbNameFor (slugOf ns)) ns.name
                  , spec =
                    { -- headless; the app reaches it by name
                      clusterIP = Some
                        "None"
                    , selector = appLabels (dbNameFor (slugOf ns))
                    , ports =
                      [ { port = 3306
                        , targetPort = Some 3306
                        , protocol = None Text
                        }
                      ]
                    }
                  }
                ]
          , None = [] : List K.Service
          }
          ns.db

let deploymentFor
    : T.Namespace → T.Workload → K.Deployment
    = λ(ns : T.Namespace) →
      λ(w : T.Workload) →
        let fsGroup =
            -- Only when there is a volume, and equal to the uid the container
            -- runs as. A PVC arrives owned by root, so without this the app is
            -- a non-root process holding a directory it cannot write — which
            -- surfaces as a permission error at the first upload rather than at
            -- startup, long after anyone would connect it to the manifest.
              if anyClaim w then Some w.uid else None Natural

        let fsGroupChangePolicy =
            -- `OnRootMismatch` if ANY mounted claim asks for it: skipping a
            -- recursive chown is cheap and safe, and a 20 Gi volume re-chowned
            -- at every start is not. `Always` is the API default and renders
            -- as absent.
              List/fold
                T.Claim
                (mountedClaims w)
                (Optional Text)
                ( λ(c : T.Claim) →
                  λ(acc : Optional Text) →
                    merge
                      { Always = acc
                      , OnRootMismatch = Some "OnRootMismatch"
                      }
                      c.chown
                )
                (None Text)

        let reachForbidsRolling =
            -- A `WireGuard` app is reached by a hostPort, and a second pod
            -- cannot bind a port the first one holds — so a rolling update does
            -- not merely risk two writers, it HANGS: the new pod stays Pending
            -- for ever while the old one is never torn down. A fact about the
            -- reach, read off the reach rather than offered as a field.
              merge
                { Ingress =
                    λ(_ : { host : Text, exposure : T.Exposure }) → False
                , WireGuard = True
                , -- Same reason as `WireGuard`, and the live manifests say so in
                  -- their own words: "hostPort binds the node interface, so two
                  -- pods can't coexist during a rollout — recreate (brief blip)
                  -- instead of a RollingUpdate that would deadlock on the port."
                  HostPorts = λ(_ : { published : List T.Published, why : Text }) → True
                , Internal = False
                , NoService = False
                }
                w.reach

        let volumeForbidsRolling =
            -- And a fact about how the app WRITES, which no manifest can imply.
            -- ReadWriteOnce does not settle it: RWO restricts a claim to one
            -- NODE, both pods land on that node, so k8s permits both mounts and
            -- the rollout does not hang — it double-writes. See `T.Writers`.
              List/fold
                T.Claim
                (mountedClaims w)
                Bool
                ( λ(c : T.Claim) →
                  λ(acc : Bool) →
                        merge
                          { Exclusive = True
                          , Concurrent = λ(_ : { why : Text }) → False
                          }
                          c.writers
                    ||  acc
                )
                False

        let strategy =
              if    reachForbidsRolling || volumeForbidsRolling
              then  Some { type = "Recreate" }
              else  None { type : Text }

        in  { apiVersion = "apps/v1"
            , kind = "Deployment"
            , metadata = meta w.name ns.name
            , spec =
              { replicas = 1
              , strategy
              , selector.matchLabels = workloadLabels w.selector w.name
              , template =
                { metadata.labels = workloadLabels w.selector w.name
                , spec =
                  { securityContext = podSecurityContext w.uid fsGroup w.hardening
                        ⫽ { fsGroupChangePolicy }
                  , restartPolicy = None Text
                  , containers =
                    [   baseContainer
                      ⫽ { name = w.name
                        , image = T.imageRef w.image
                        , imagePullPolicy = T.pullPolicyFor w.image
                        , command = w.command
                        , -- ⚠ `Unhardened` drops this too, and that is the
                          -- point: `drop: ALL` takes CAP_CHOWN/CAP_SETUID/
                          -- CAP_SETGID, which is exactly what an entrypoint
                          -- running usermod as root needs. Hardening the POD
                          -- but not the CONTAINER crash-loops it just the same.
                          securityContext =
                            merge
                              { NonRoot =
                                  Some (containerSecurityContext w.rootFs)
                              , Unhardened =
                                  λ(_ : { why : Text }) →
                                    None K.ContainerSecurityContext
                              }
                              w.hardening
                        , -- ⚠ `NoService` declares NO containerPort. Nothing
                          -- dials this pod, and a declared port nobody connects
                          -- to reads to a reviewer as an interface that exists —
                          -- the same reason `Reach.NoService` renders no Service.
                          ports =
                            L.nonEmpty
                              K.ContainerPort
                              ( merge
                              { Ingress =
                                  λ ( _
                                    : { host : Text, exposure : T.Exposure }
                                    ) →
                                    [ { containerPort = w.port
                                      , hostPort = None Natural
                                      , hostIP = None Text
                                      }
                                    ]
                              , WireGuard =
                                [ { containerPort = w.port
                                  , -- ⚠ Same number by POLICY, not by necessity,
                                    -- and this comment claimed otherwise until
                                    -- 2026-08-27. It read "a hostPort that
                                    -- disagrees with the containerPort forwards
                                    -- to nothing, silently" — false: the CNI
                                    -- portmap plugin DNATs host dport to the
                                    -- container's port and the two may differ
                                    -- (`vps/irssi` has run 2230 -> 22 for 51
                                    -- days; evidence in `T.Reach`). `25fdbee5`
                                    -- corrected the copy in types.dhall and
                                    -- MISSED this one, so the falsified claim
                                    -- outlived its own correction by a day.
                                    --
                                    -- What is true: a WireGuard app is reached
                                    -- at the port it serves, so one number is
                                    -- named once. That is a choice, and it is
                                    -- why a deliberate remap is inexpressible.
                                    hostPort = Some w.port
                                  , hostIP = Some (T.wgAddress (T.soleCluster ns.placement))
                                  }
                                ]
                              , -- ⚠ `hostIP` UNSET, unlike `WireGuard`: these
                                -- bind every interface because the clients are
                                -- people on the internet, not the fleet. And the
                                -- two numbers are whatever the model says — the
                                -- CNI portmap plugin DNATs between them.
                                HostPorts =
                                  λ ( r
                                    : { published : List T.Published, why : Text }
                                    ) →
                                    L.map
                                      T.Published
                                      K.ContainerPort
                                      ( λ(x : T.Published) →
                                          { containerPort = x.containerPort
                                          , hostPort = Some x.hostPort
                                          , hostIP = None Text
                                          }
                                      )
                                      r.published
                              , Internal =
                                [ { containerPort = w.port
                                  , hostPort = None Natural
                                  , hostIP = None Text
                                  }
                                ]
                              , NoService = [] : List K.ContainerPort
                              }
                              w.reach
                              )
                        , env =
                            L.nonEmpty
                              K.EnvVar
                              ( L.map
                                  T.EnvVar
                                  K.EnvVar
                                  (renderEnv (secretNameFor (slugOf ns)))
                                  w.env
                              )
                        , readinessProbe =
                            -- `readiness` overrides BOTH the question and the two
                            -- timings a deep probe cannot leave at kubelet's
                            -- defaults; absent, readiness asks `probe` — the same
                            -- question as liveness, which is what every workload
                            -- did before the field existed.
                            merge
                              { None =
                                  merge
                                    { None = None K.Probe
                                    , Some =
                                        λ(pr : K.Probe) →
                                          Some
                                            (   pr
                                              ⫽ { initialDelaySeconds = Some
                                                    w.probeTiming.readiness.initialDelaySeconds
                                                , periodSeconds = Some
                                                    w.probeTiming.readiness.periodSeconds
                                                }
                                            )
                                    }
                                    (renderProbe w.probe)
                              , Some =
                                  λ(r : T.Readiness) →
                                    merge
                                      { None = None K.Probe
                                      , Some =
                                          λ(pr : K.Probe) →
                                            Some
                                              (   pr
                                                ⫽ { initialDelaySeconds = Some
                                                      w.probeTiming.readiness.initialDelaySeconds
                                                  , periodSeconds = Some
                                                      w.probeTiming.readiness.periodSeconds
                                                  , timeoutSeconds = Some
                                                      r.timeoutSeconds
                                                  , failureThreshold = Some
                                                      r.failureThreshold
                                                  }
                                              )
                                      }
                                      (renderProbe r.probe)
                              }
                              w.readiness
                        , livenessProbe =
                            merge
                              { None = None K.Probe
                              , Some =
                                  λ(pr : K.Probe) →
                                    Some
                                      (   pr
                                        ⫽ { initialDelaySeconds = Some
                                              w.probeTiming.liveness.initialDelaySeconds
                                          , periodSeconds = Some
                                              w.probeTiming.liveness.periodSeconds
                                          }
                                      )
                              }
                              (renderProbe w.probe)
                        , -- Whether a container ought to state limits is a
                          -- fact about its image, which dev-lint knows and this
                          -- does not. See `k8sResources` for why the two record
                          -- types are no longer identical.
                          resources = Some (k8sResources w.resources)
                        , volumeMounts =
                            L.nonEmpty
                              K.VolumeMount
                              ( L.map
                                  T.VolumeMount
                                  K.VolumeMount
                                  k8sMount
                                  w.mounts
                              )
                        }
                    ]
                  , volumes =
                      L.nonEmpty
                        K.Volume
                        (L.map T.Volume K.Volume k8sVolume w.volumes)
                  }
                }
              }
            }

--| One Deployment per workload in the namespace.
let deployments
    : T.Namespace → List K.Deployment
    = λ(ns : T.Namespace) →
        L.map T.Workload K.Deployment (deploymentFor ns) ns.workloads

--| ι applied: the generator hands each renderer an `apps/*.dhall`, whose type is
--  still `T.App`, so the entry points keep that shape and the generalised work
--  happens behind `namespaceOf`.
let appDeployment = deployments

--| The port the app's Service listens on — ONE expression, read by both the
--  Service and the Ingress backend that targets it.
--
-- 80 for an app behind an Ingress, which is the convention the backend follows;
-- the app's own port otherwise, where there is no Ingress to have a convention
-- with. scanner's live Service is on 8090 for exactly that reason, and the
-- hardcoded 80 is what stopped it joining the model.
--
-- Derived at both sites rather than written twice, for the same reason
-- `Reach.WireGuard` derives the hostPort from the containerPort: a Service port
-- and an Ingress backend that disagree forward to nothing, and say nothing
-- about it.
let servicePort
    : T.Workload → Natural
    = λ(w : T.Workload) →
        merge
          { Ingress = λ(_ : { host : Text, exposure : T.Exposure }) → 80
          , WireGuard = w.port
          , Internal = w.port
          , -- Never evaluated, same as `NoService` below.
            HostPorts = λ(_ : { published : List T.Published, why : Text }) → w.port
          , -- Never evaluated: `serviceFor` renders no Service for this arm, so
            -- the port is not a fallback anybody can reach. Stated rather than
            -- left to a wildcard so adding a further arm stays a type error.
            NoService = w.port
          }
          w.reach

let cronJobsFor
    : T.Namespace → T.Workload → List K.CronJob
    = λ(ns : T.Namespace) →
      λ(w : T.Workload) →
        L.map
          T.ScheduledTask
          K.CronJob
          ( λ(t : T.ScheduledTask) →
              { apiVersion = "batch/v1"
              , kind = "CronJob"
              , metadata = meta t.name ns.name
              , spec =
                { schedule = t.schedule
                , suspend = if t.suspended then Some True else None Bool
                , -- Never two at once. These jobs write the same rows — a
                  -- decode overlapping its predecessor is not slow, it is
                  -- wrong — and `Allow` is the API's default, so it has to be
                  -- said.
                  concurrencyPolicy = "Forbid"
                , successfulJobsHistoryLimit = 3
                , -- Kept at 3 rather than the API's 1: the failed run is the
                  -- one somebody wants the logs of, and 1 means the second
                  -- failure erases the first.
                  failedJobsHistoryLimit = 3
                , jobTemplate.spec
                  =
                  { activeDeadlineSeconds = t.deadlineSeconds
                  , backoffLimit = None Natural
                  , -- Named after the task, so a policy can select this job's
                    -- pods and only this job's. See `K.JobSpec`.
                    template.metadata.labels
                    = appLabels t.name
                  , template.spec
                    =
                    { securityContext = podSecurityContext w.uid (None Natural) w.hardening
                    , restartPolicy = Some "OnFailure"
                    , -- The TASK's volumes, not the workload's. A batch job that
                      -- inherited the long-running pod's mounts would get write
                      -- access to that pod's data as a side effect of wanting a
                      -- scratch directory; see `T.ScheduledTask`.
                      volumes =
                        L.nonEmpty
                          K.Volume
                          (L.map T.Volume K.Volume k8sVolume t.volumes)
                    , containers =
                      [   baseContainer
                        ⫽ { name = t.name
                          , image = T.imageRef w.image
                          , command = Some t.command
                          , -- `t.rootFs`, not the workload's: a task states its
                            -- own filesystem posture. `hardening` and `image`
                            -- are still the workload's, which is the sharing
                            -- `T.Workload.tasks` describes.
                            securityContext =
                              merge
                                { NonRoot =
                                    Some
                                      (containerSecurityContext t.rootFs)
                                , Unhardened =
                                    λ(_ : { why : Text }) →
                                      None K.ContainerSecurityContext
                                }
                                w.hardening
                          , env = Some
                              ( L.map
                                  T.EnvVar
                                  K.EnvVar
                                  (renderEnv (secretNameFor (slugOf ns)))
                                  t.env
                              )
                          , resources = Some (k8sResources t.resources)
                          , volumeMounts =
                              L.nonEmpty
                                K.VolumeMount
                                ( L.map
                                    T.VolumeMount
                                    K.VolumeMount
                                    k8sMount
                                    t.mounts
                                )
                          }
                      ]
                    }
                  }
                }
              }
          )
          w.tasks

--| The app's batch work, one CronJob each.
--
-- They share the app's IMAGE, UID, namespace and secret — a scheduled task is
-- the same program with a different entrypoint, not a separate app — and differ
-- only in schedule, command, deadline, env and resources. That sharing is the
-- reason the type is thin: everything a task could get wrong by restating it is
-- taken from the workload instead.
--
-- ⚠ The container is named after the TASK, where the live tree names them
-- `sync` / `refresh` / `decode` — three names for eight jobs, so `kubectl logs`
-- on a failed run needs the pod name to disambiguate. Harmless to change: every
-- cron run creates a fresh pod, so there is no rolling update to survive.
let cronJobs
    : T.Namespace → List K.CronJob
    = λ(ns : T.Namespace) →
        L.concatMap T.Workload K.CronJob (cronJobsFor ns) ns.workloads

let serviceFor
    : T.Namespace → T.Workload → List K.Service
    = λ(ns : T.Namespace) →
      λ(w : T.Workload) →
        let svc =
              [ { apiVersion = "v1"
                , kind = "Service"
                , metadata = meta w.name ns.name
                , spec =
                  { clusterIP = None Text
                  , selector = workloadLabels w.selector w.name
                  , ports =
                    [ { port = servicePort w
                      , targetPort = Some w.port
                      , protocol = None Text
                      }
                    ]
                  }
                }
              ]

        in  merge
              { Ingress = λ(_ : { host : Text, exposure : T.Exposure }) → svc
              , WireGuard = svc
              , Internal = svc
              , HostPorts = λ(_ : { published : List T.Published, why : Text }) → [] : List K.Service
              , NoService = [] : List K.Service
              }
              w.reach

let services
    : T.Namespace → List K.Service
    = λ(ns : T.Namespace) →
        L.concatMap T.Workload K.Service (serviceFor ns) ns.workloads

let appService = services

let ingressFor
    : T.Namespace → T.Workload → List K.Ingress
    = λ(ns : T.Namespace) →
      λ(w : T.Workload) →
        merge
          { Ingress =
              λ(r : { host : Text, exposure : T.Exposure }) →
                let host = r.host

                in  [ { apiVersion = "networking.k8s.io/v1"
                      , kind = "Ingress"
                      , metadata =
                            meta (ingressNameOf ns) ns.name
                          ⫽ { annotations = Some
                                ( toMap
                                    { `cert-manager.io/cluster-issuer` =
                                        T.issuerFor r.exposure
                                    }
                                )
                            }
                      , spec =
                        { ingressClassName = "nginx"
                        , tls =
                          [ { hosts = [ host ], secretName = "${slugOf ns}-tls" }
                          ]
                        , rules =
                          [ { host
                            , http.paths
                              =
                              [ { path = "/"
                                , pathType = "Prefix"
                                , backend.service
                                  =
                                  { name = w.name, port.number = servicePort w }
                                }
                              ]
                            }
                          ]
                        }
                      }
                    ]
          , WireGuard = [] : List K.Ingress
          , Internal = [] : List K.Ingress
          , HostPorts = λ(_ : { published : List T.Published, why : Text }) → [] : List K.Ingress
          , NoService = [] : List K.Ingress
          }
          w.reach

let ingresses
    : T.Namespace → List K.Ingress
    = λ(ns : T.Namespace) →
        L.concatMap T.Workload K.Ingress (ingressFor ns) ns.workloads

let ingress = ingresses

--| Only the app may reach the database. Rendered whenever the app has one, so
--  "namespace has a DB but nothing protecting it" is not a state this model can
--  produce.
let netpolDb
    : T.Namespace → List K.NetworkPolicy
    = λ(ns : T.Namespace) →
        merge
          { Some =
              λ(_ : T.Database) →
                [ { apiVersion = "networking.k8s.io/v1"
                  , kind = "NetworkPolicy"
                  , -- The NAME follows the rule rather than being fixed to it.
                    -- With batch tasks the policy admits the namespace, and a
                    -- manifest called `-db-from-app-only` that does not do that
                    -- is precisely the drift this model exists to make
                    -- impossible. Safe to vary: the only app it renames for has
                    -- no NetworkPolicy today, so nothing is orphaned.
                    metadata =
                      meta
                        ( if    Natural/isZero
                                  ( List/length
                                      T.ScheduledTask
                                      ( L.concatMap
                                          T.Workload
                                          T.ScheduledTask
                                          (λ(w : T.Workload) → w.tasks)
                                          ns.workloads
                                      )
                                  )
                          then  "${ns.name}-db-from-app-only"
                          else  "${ns.name}-db-from-namespace"
                        )
                        ns.name
                  , spec =
                    { podSelector.matchLabels = Some (appLabels (dbNameFor (slugOf ns)))
                    , policyTypes = [ "Ingress" ]
                    , ingress = Some
                      [ { from =
                          [ { ipBlock = None { cidr : Text, except : Optional (List Text) }
                            , -- ⚠ AN APP WITH BATCH TASKS OPENS THIS TO THE
                              -- WHOLE NAMESPACE, and the narrower rule is not
                              -- available: a CronJob's pods carry only the
                              -- labels the Job controller generates
                              -- (`job-name`, `controller-uid`), which are
                              -- per-run and cannot be named in advance. Naming
                              -- the long-running workload alone would render a
                              -- policy that reads correct and cuts every cron
                              -- off from the database — silently, at 04:00,
                              -- since a batch pod has no probe and no readiness
                              -- for anything to notice. `--check` caught
                              -- exactly that on health before it was applied.
                              --
                              -- `podSelector: {}` is a selector with no terms,
                              -- which matches every pod IN THIS NAMESPACE. It
                              -- is a real policy — nothing outside the app's own
                              -- namespace reaches the database — just not a
                              -- per-pod one.
                              podSelector = Some
                              { matchLabels =
                                  merge
                                    { None = None K.Labels
                                    , Some =
                                        λ(w : T.Workload) →
                                          if    Natural/isZero
                                                  ( List/length
                                                      T.ScheduledTask
                                                      w.tasks
                                                  )
                                          then  Some (workloadLabels w.selector w.name)
                                          else  None K.Labels
                                    }
                                    (soleWorkload ns)
                              }
                            , namespaceSelector =
                                None { matchLabels : K.Labels }
                            }
                          ]
                        , -- `TCP` STATED, though it is the API's default, and
                          -- this is not tidiness. A NetworkPolicy's `ports` is
                          -- an ATOMIC list — no patch merge key — so `kubectl
                          -- apply` replaces it wholesale. Omit the protocol and
                          -- the patch drops the `TCP` the API defaulted in, the
                          -- API puts it back, and the object reports
                          -- `configured` on every apply for ever. Measured
                          -- 2026-08-14: every db policy in the fleet did this,
                          -- so `apply.sh`'s "no changes" verdict was false about
                          -- netpols everywhere.
                          ports = [ { port = 3306, protocol = Some "TCP" } ]
                        }
                      ]
                    , -- Says nothing about egress, as opposed to denying it:
                      -- `policyTypes` lists Ingress alone.
                      egress =
                        None
                          ( List
                              { to : List K.NetworkPolicyPeer
                              , ports : List K.NetworkPolicyPort
                              }
                          )
                    }
                  }
                ]
          , None = [] : List K.NetworkPolicy
          }
          ns.db

--| ⚠️ HELD, not applied. k3s enforces NetworkPolicy via kube-router, which does
--  NOT exempt node-sourced kubelet probe traffic — applying this as written
--  drops the liveness/readiness probes, marks the pod NotReady and takes the
--  site down. Rendered to its own file so the intent stays reviewed, but it is
--  deliberately outside the applied set until a probe-source rule is added and
--  verified on a live pod.
let ingressFromNginx
    : T.Namespace → T.Workload → K.NetworkPolicy
    = λ(ns : T.Namespace) →
      λ(w : T.Workload) →
        { apiVersion = "networking.k8s.io/v1"
        , kind = "NetworkPolicy"
        , metadata = meta "${slugOf ns}-app-from-ingress-only" ns.name
        , spec =
          { podSelector.matchLabels = Some (appLabels w.name)
          , policyTypes = [ "Ingress" ]
          , ingress = Some
            [ { from =
                [ { ipBlock = None { cidr : Text, except : Optional (List Text) }
                  , podSelector = None { matchLabels : Optional K.Labels }
                  , -- Selected by the namespace's automatic
                    -- kubernetes.io/metadata.name label rather than chart pod
                    -- labels, which change across versions.
                    namespaceSelector = Some
                    { matchLabels = toMap
                        { `kubernetes.io/metadata.name` = "ingress-nginx" }
                    }
                  }
                ]
              , -- STATED, never implicit. This list is atomic, so an omitted
                -- protocol makes every apply report `configured` for ever —
                -- see `K.NetworkPolicyPort`, and DL-K8S-NP-PORT-PROTOCOL,
                -- which now checks the rendered YAML for exactly this.
                ports = [ { port = w.port, protocol = Some "TCP" } ]
              }
            ]
          , egress =
              None
                ( List
                    { to : List K.NetworkPolicyPeer
                    , ports : List K.NetworkPolicyPort
                    }
                )
          }
        }

--| Default-deny egress for the whole namespace, with named exceptions.
--
-- `podSelector: {}` — the namespace, not a label match — because a policy that
-- selected only the app's own pods would leave anything else scheduled there
-- unrestricted, and the point of a default-deny is that it has no holes.
--| One `T.NetpolPolicy` → one NetworkPolicy. EVERY applied policy in the fleet
--  goes through here, including the `Egress` sugar below, so there is one
--  expression deciding what a peer means.
let renderPolicy
    : T.Namespace → T.NetpolPolicy → K.NetworkPolicy
    = λ(ns : T.Namespace) →
      λ(pol : T.NetpolPolicy) →
        let emptyPeer =
              { ipBlock = None { cidr : Text, except : Optional (List Text) }
              , podSelector = None { matchLabels : Optional K.Labels }
              , namespaceSelector = None { matchLabels : K.Labels }
              }

        let peer =
              λ(t : T.NetpolPeer) →
                merge
                  { Namespace =
                      λ(n : Text) →
                            emptyPeer
                        ⫽ { namespaceSelector = Some
                            { matchLabels = toMap
                                { `kubernetes.io/metadata.name` = n }
                            }
                          }
                  , Workload =
                      λ(n : Text) →
                            emptyPeer
                        ⫽ { podSelector = Some
                              { matchLabels = Some (appLabels n) }
                          }
                  , SameNamespace =
                          emptyPeer
                      ⫽ { podSelector = Some { matchLabels = None K.Labels } }
                  , NamespacedWorkload =
                      λ ( x
                        : { namespace : Text
                          , labels : List { mapKey : Text, mapValue : Text }
                          }
                        ) →
                        -- BOTH selectors in ONE peer: "in that namespace AND
                        -- matching these labels". Two separate peers would mean
                        -- "either", which silently widens the policy.
                            emptyPeer
                        ⫽ { namespaceSelector = Some
                            { matchLabels = toMap
                                { `kubernetes.io/metadata.name` = x.namespace }
                            }
                          , podSelector = Some { matchLabels = Some x.labels }
                          }
                  , Internet =
                      λ(x : { except : List Text }) →
                            emptyPeer
                        ⫽ { ipBlock = Some
                            { cidr = "0.0.0.0/0", except = L.nonEmpty Text x.except }
                          }
                  , Host =
                      λ(x : { cidr : Text, why : Text }) →
                            emptyPeer
                        ⫽ { ipBlock = Some
                            { cidr = x.cidr, except = None (List Text) }
                          }
                  }
                  t

        in  { apiVersion = "networking.k8s.io/v1"
            , kind = "NetworkPolicy"
            , metadata = meta pol.name ns.name
            , spec =
              { podSelector.matchLabels =
                  merge
                    { WholeNamespace = None K.Labels
                    , OneWorkload = λ(n : Text) → Some (appLabels n)
                    }
                    pol.target
              , policyTypes = [ "Egress" ]
              , -- `None`, not an empty list: this governs egress only, and a
                -- rendered `ingress: []` beside `policyTypes: [Egress]` would
                -- read as a denial it does not make.
                ingress =
                  None
                    ( List
                        { from : List K.NetworkPolicyPeer
                        , ports : List K.NetworkPolicyPort
                        }
                    )
              , -- ⚠ `L.nonEmpty`, and an empty list renders ABSENT. This used
                -- to read "an EMPTY list is the whole point when nothing is
                -- allowed", which mistook where the denial lives: with `Egress`
                -- in `policyTypes` and no rules, outbound is denied whether the
                -- key is `[]` or missing. The API agrees so firmly that it
                -- STRIPS the empty list on write — so a manifest sending one
                -- disagrees with the stored object for ever, and `apply.sh`
                -- reported observe's and scanner's default-deny as `configured`
                -- on every run. observe's was at generation 6 from re-applying
                -- a policy that never changed.
                egress =
                  L.nonEmpty
                    { to : List K.NetworkPolicyPeer
                    , ports : List K.NetworkPolicyPort
                    }
                  ( L.map
                      T.NetpolRule
                      { to : List K.NetworkPolicyPeer
                      , ports : List K.NetworkPolicyPort
                      }
                      ( λ(r : T.NetpolRule) →
                          { to = L.map T.NetpolPeer K.NetworkPolicyPeer peer r.to
                          , ports =
                              L.map
                                { port : Natural, protocol : Text }
                                K.NetworkPolicyPort
                                ( λ(x : { port : Natural, protocol : Text }) →
                                    { port = x.port, protocol = Some x.protocol }
                                )
                                r.ports
                          }
                      )
                      pol.egress
                  )
              }
            }

--| The `Egress` sugar, expanded. One namespace-wide default-deny whose
--  exceptions are whole namespaces — which is what three apps say and all they
--  need to say.
let defaultDenyOf
    : List T.EgressTo → T.NetpolPolicy
    = λ(allowed : List T.EgressTo) →
        { name = "default-deny-egress"
        , target = T.NetpolTarget.WholeNamespace
        , egress =
            L.map
              T.EgressTo
              T.NetpolRule
              ( λ(e : T.EgressTo) →
                  { to = [ T.NetpolPeer.Namespace e.namespace ], ports = e.ports }
              )
              allowed
        }

--| ⚠️ HELD, not applied. k3s enforces NetworkPolicy via kube-router, which does
--  NOT exempt node-sourced kubelet probe traffic — applying this as written
--  drops the liveness/readiness probes, marks the pod NotReady and takes the
--  site down. Rendered to its own file so the intent stays reviewed, but it is
--  deliberately outside the applied set until a probe-source rule is added and
--  verified on a live pod.
let ingressFromNginx
    : T.Namespace → T.Workload → K.NetworkPolicy
    = λ(ns : T.Namespace) →
      λ(w : T.Workload) →
        { apiVersion = "networking.k8s.io/v1"
        , kind = "NetworkPolicy"
        , metadata = meta "${slugOf ns}-app-from-ingress-only" ns.name
        , spec =
          { podSelector.matchLabels = Some (appLabels w.name)
          , policyTypes = [ "Ingress" ]
          , ingress = Some
            [ { from =
                [ { ipBlock = None { cidr : Text, except : Optional (List Text) }
                  , podSelector = None { matchLabels : Optional K.Labels }
                  , -- Selected by the namespace's automatic
                    -- kubernetes.io/metadata.name label rather than chart pod
                    -- labels, which change across versions.
                    namespaceSelector = Some
                    { matchLabels = toMap
                        { `kubernetes.io/metadata.name` = "ingress-nginx" }
                    }
                  }
                ]
              , -- STATED, never implicit. This list is atomic, so an omitted
                -- protocol makes every apply report `configured` for ever —
                -- see `K.NetworkPolicyPort`, and DL-K8S-NP-PORT-PROTOCOL,
                -- which now checks the rendered YAML for exactly this.
                ports = [ { port = w.port, protocol = Some "TCP" } ]
              }
            ]
          , egress =
              None
                ( List
                    { to : List K.NetworkPolicyPeer
                    , ports : List K.NetworkPolicyPort
                    }
                )
          }
        }

--| Default-deny egress for the whole namespace, with named exceptions.
--
-- `podSelector: {}` — the namespace, not a label match — because a policy that
-- selected only the app's own pods would leave anything else scheduled there
-- unrestricted, and the point of a default-deny is that it has no holes.
let egressDefaultDeny
    : T.Namespace → List T.EgressTo → K.NetworkPolicy
    = λ(ns : T.Namespace) →
      λ(allowed : List T.EgressTo) →
        { apiVersion = "networking.k8s.io/v1"
        , kind = "NetworkPolicy"
        , metadata = meta "default-deny-egress" ns.name
        , spec =
          { podSelector.matchLabels = None K.Labels
          , policyTypes = [ "Egress" ]
          , -- `None`, not an empty list: this policy governs egress only, and a
            -- rendered `ingress: []` beside `policyTypes: [Egress]` would read
            -- as a denial it does not make.
            ingress =
              None
                ( List
                    { from : List K.NetworkPolicyPeer
                    , ports : List K.NetworkPolicyPort
                    }
                )
          , -- `Some`, and an EMPTY list is the whole point when `allowed` is
            -- empty: with Egress in policyTypes it denies all outbound traffic.
            egress = Some
              ( L.map
                  T.EgressTo
                  { to : List K.NetworkPolicyPeer
                  , ports : List K.NetworkPolicyPort
                  }
                  ( λ(e : T.EgressTo) →
                      { to =
                        [ { ipBlock = None { cidr : Text, except : Optional (List Text) }
                          , podSelector =
                              None { matchLabels : Optional K.Labels }
                          , namespaceSelector = Some
                            { matchLabels = toMap
                                { `kubernetes.io/metadata.name` = e.namespace }
                            }
                          }
                        ]
                      , ports =
                          L.map
                            { port : Natural, protocol : Text }
                            K.NetworkPolicyPort
                            ( λ(p : { port : Natural, protocol : Text }) →
                                { port = p.port, protocol = Some p.protocol }
                            )
                            e.ports
                      }
                  )
                  allowed
              )
          }
        }

--| ⚠️ HELD, not applied. k3s enforces NetworkPolicy via kube-router, which does
--  NOT exempt node-sourced kubelet probe traffic — applying this as written
--  drops the liveness/readiness probes, marks the pod NotReady and takes the
--  site down. Rendered to its own file so the intent stays reviewed, but it is
--  deliberately outside the applied set until a probe-source rule is added and
--  verified on a live pod.
--
-- Only the `IngressFromNginx` arm lands here. The egress policies ARE applied
-- and go to `netpolApp` below, which is the whole reason `netpol` stopped being
-- a Bool: the two policies differ in whether they reach the cluster at all.
let netpolAppHeld
    : T.Namespace → List K.NetworkPolicy
    = λ(ns : T.Namespace) →
        merge
          { Unpoliced = [] : List K.NetworkPolicy
          , IngressFromNginx =
              L.map T.Workload K.NetworkPolicy (ingressFromNginx ns) ns.workloads
          , Egress = λ(_ : List T.EgressTo) → [] : List K.NetworkPolicy
          , Policies = λ(_ : List T.NetpolPolicy) → [] : List K.NetworkPolicy
          }
          ns.netpol

--| The APPLIED app policy, as opposed to the held one above.
let netpolApp
    : T.Namespace → List K.NetworkPolicy
    = λ(ns : T.Namespace) →
        merge
          { Unpoliced = [] : List K.NetworkPolicy
          , IngressFromNginx = [] : List K.NetworkPolicy
          , Egress =
              λ(allowed : List T.EgressTo) →
                [ renderPolicy ns (defaultDenyOf allowed) ]
          , Policies =
              λ(ps : List T.NetpolPolicy) →
                L.map T.NetpolPolicy K.NetworkPolicy (renderPolicy ns) ps
          }
          ns.netpol

in  { storageWaiver
    , hostPathWaiver
    , containerWaivers
    , unhardenedWaiver
    , namespace
    , configMap
    , pvc
    , appPvc
    , dbDeployment
    , dbService
    , appDeployment
    , cronJobs
    , appService
    , ingress
    , netpolDb
    , netpolAppHeld
    , netpolApp
    , mariadbVersion
    , secretName
    , clusterHosts
    , hostOf
    , hasDb
    , hasAppliedNetpol
    , usesHostPort
    , unownedFiles
    }
