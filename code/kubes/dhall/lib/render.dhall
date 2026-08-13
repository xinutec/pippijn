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
let hasAppliedNetpol
    : T.App → Bool
    = λ(app : T.App) →
        merge
          { Unpoliced = False
          , IngressFromNginx = False
          , Egress = λ(_ : List T.EgressTo) → True
          }
          app.netpol

--| Does this app's Deployment carry a `hostPort`?
--
-- Asked by `generate.sh` to decide whether to emit the `allow-host-port` waiver.
-- `WireGuard` is the only arm that renders one, and it always does — the hostPort
-- pinned to the tunnel address IS how such an app is reached, so the question is
-- answered by the reach and never per-app.
--
-- Same discipline as `hasAppliedNetpol`: dev-lint fails a waiver that waives
-- nothing, so this must be the model's answer rather than a list in the
-- generator that a new app can be missing from.
let usesHostPort
    : T.App → Bool
    = λ(app : T.App) →
        merge
          { Ingress = λ(_ : { host : Text, exposure : T.Exposure }) → False
          , WireGuard = True
          , Internal = False
          }
          app.reach

let hasDb
    : T.App → Bool
    = λ(app : T.App) → merge { None = False, Some = λ(_ : T.Database) → True } app.db

--| The host `scripts/apply.sh` must deploy to. The cluster has been a field on
--  `T.App` since the model existed; until 2026-08-10 nothing read it, and the
--  deploy tool asked whoever was typing instead. See `site.dhall`'s twin.
let clusterHost
    : T.App → Text
    = λ(app : T.App) →
        merge
          { isis = "isis.xinutec.org", amun = "amun.xinutec.org" }
          app.cluster

-- Keyed on the NAMESPACE NAME rather than on an `App`, because both `T.App` and
-- `T.Namespace` need them and Dhall has no subtyping — a function taking one
-- record type will not accept a wider one. The `App`-shaped versions below are
-- the same expressions, so the derivation stays single-sourced.
let secretNameFor = λ(name : Text) → "${name}-secret"

let dbNameFor = λ(name : Text) → "${name}-db"

let pvcNameFor = λ(name : Text) → "${name}-db-pvc"

let dataPvcNameFor = λ(name : Text) → "${name}-data-pvc"

let secretName = λ(app : T.App) → secretNameFor app.name

let dbName = λ(app : T.App) → dbNameFor app.name

let pvcName = λ(app : T.App) → pvcNameFor app.name

let dataPvcName = λ(app : T.App) → dataPvcNameFor app.name

--| The pod-local name of the app's own volume. Distinct from the database's
--  `data` volume, which lives in a different pod entirely.
let dataVolumeName = "app-data"

--| The labels an app's pod template, Service and policies all select on. One
--  expression, so a Service selector cannot disagree with what it selects.
let appLabels
    : Text → K.Labels
    = λ(name : Text) → toMap { app = name }

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
    : Text → K.Meta
    = λ(name : Text) →
        { name
        , namespace = None Text
        , annotations = None Annotations
        , labels = None Annotations
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
    : T.Probe → K.Probe
    = λ(p : T.Probe) →
        merge
          { Http = λ(h : K.HTTPGetAction) → K.emptyProbe ⫽ { httpGet = Some h }
          , Exec = λ(e : K.ExecAction) → K.emptyProbe ⫽ { exec = Some e }
          , Tcp = λ(t : K.TCPSocketAction) → K.emptyProbe ⫽ { tcpSocket = Some t }
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
      , ports = [] : List K.ContainerPort
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
              }

        in  merge
              { EmptyDir = empty ⫽ { emptyDir = Some {=} }
              , ConfigMap =
                  λ(c : { name : Text }) → empty ⫽ { configMap = Some c }
              , HostPath =
                  λ(h : { path : Text, why : Text }) →
                    empty ⫽ { hostPath = Some { path = h.path, type = "Directory" } }
              }
              v.source

let podSecurityContext
    : Natural → Optional Natural → K.PodSecurityContext
    = λ(uid : Natural) →
      λ(fsGroup : Optional Natural) →
        { runAsNonRoot = True
        , runAsUser = uid
        , runAsGroup = uid
        , fsGroup
        , fsGroupChangePolicy = None Text
        , seccompProfile.type = "RuntimeDefault"
        }

let containerSecurityContext
    : Bool → K.ContainerSecurityContext
    = λ(readOnlyRootFs : Bool) →
        { allowPrivilegeEscalation = False
        , readOnlyRootFilesystem =
            if readOnlyRootFs then Some True else None Bool
        , capabilities.drop = [ "ALL" ]
        }

let namespace
    : T.App → List K.Namespace
    = λ(app : T.App) →
        [ { apiVersion = "v1"
          , kind = "Namespace"
          , metadata = clusterMeta app.name
          }
        ]

--| The app's own ConfigMap, if it declares one.
--
-- A list rather than an Optional so the generator concatenates it like every
-- other renderer: an app with no ConfigMap renders no document, and the file is
-- simply not written. Same shape as `pvc`, for the same reason.
let configMap
    : T.App → List K.ConfigMap
    = λ(app : T.App) →
        merge
          { None = [] : List K.ConfigMap
          , Some =
              λ(cm : T.ConfigMapDoc) →
                [ { apiVersion = "v1"
                  , kind = "ConfigMap"
                  , metadata = meta cm.name app.name
                  , data = cm.files
                  }
                ]
          }
          app.configMap

--| The backup-coverage waiver an app's own claim should carry, or "" for none.
--
-- Empty means "no waiver": either the app has no volume of its own, or it
-- declared `BackedUp` and must genuinely appear in backup-prepare.sh — dev-lint
-- checks that join across the fleet, so the claim cannot be merely asserted.
--
-- The generator used to hold this as a hardcoded case for one app. Moving it
-- into the model means a second app cannot be added without answering the
-- question, and the answer sits beside the volume it describes rather than in a
-- shell `case` far away from it.
let storageWaiver
    : T.App → Text
    = λ(app : T.App) →
        merge
          { Some =
              λ(s : T.Storage) →
                merge
                  { BackedUp = ""
                  , LossAccepted = λ(r : { why : Text }) → r.why
                  }
                  s.durability
          , None = ""
          }
          app.storage

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
    : T.App → Text
    = λ(app : T.App) →
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
                        , HostPath = λ(h : { path : Text, why : Text }) → [ h.why ]
                        }
                        v.source
                  )
                  app.workload.volumes
              )
          )

let pvc
    : T.App → List K.PersistentVolumeClaim
    = λ(app : T.App) →
        merge
          { Some =
              λ(d : T.Database) →
                [ { apiVersion = "v1"
                  , kind = "PersistentVolumeClaim"
                  , metadata = meta (pvcName app) app.name
                  , spec =
                    { accessModes = [ "ReadWriteOnce" ]
                    , resources.requests.storage
                      = "${Natural/show d.storageGi}Gi"
                    }
                  }
                ]
          , None = [] : List K.PersistentVolumeClaim
          }
          app.db

--| The claim behind [`T.Storage`], if the app declared one.
--
-- Rendered into the same file as the database's claim, so `01-pvc.yaml` is
-- every piece of durable state a namespace owns rather than only the half that
-- happens to be a database.
let appPvc
    : T.App → List K.PersistentVolumeClaim
    = λ(app : T.App) →
        merge
          { Some =
              λ(s : T.Storage) →
                [ { apiVersion = "v1"
                  , kind = "PersistentVolumeClaim"
                  , metadata = meta (dataPvcName app) app.name
                  , spec =
                    { accessModes = [ "ReadWriteOnce" ]
                    , resources.requests.storage
                      = "${Natural/show s.storageGi}Gi"
                    }
                  }
                ]
          , None = [] : List K.PersistentVolumeClaim
          }
          app.storage

let dbDeployment
    : T.App → List K.Deployment
    = λ(app : T.App) →
        merge
          { Some =
              λ(d : T.Database) →
                [ { apiVersion = "apps/v1"
                  , kind = "Deployment"
                  , metadata = meta (dbName app) app.name
                  , spec =
                    { replicas = 1
                    , -- Single RWO PVC: never run two DB pods at once.
                      strategy = Some { type = "Recreate" }
                    , selector.matchLabels = appLabels (dbName app)
                    , template =
                      { metadata.labels = appLabels (dbName app)
                      , spec =
                        { -- The official image runs as uid 999 (mysql) when
                          -- started unprivileged; fsGroup keeps the data dir
                          -- writable.
                          securityContext = podSecurityContext 999 (Some 999)
                        , restartPolicy = None Text
                        , containers =
                          [     baseContainer
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
                                                                             ( gi
                                                                             * 1024
                                                                             * 1024
                                                                             * 1024
                                                                             )}"
                                            ]
                                    }
                                    d.innodbBufferPoolGi
                              , -- No readOnlyRootFilesystem: mariadb writes
                                -- /run/mysqld and its data dir.
                                securityContext = containerSecurityContext False
                              , env = Some
                                ( L.map
                                    T.EnvVar
                                    K.EnvVar
                                    (renderEnv (secretName app))
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
                              , ports =
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
                                  (   execProbe [ "healthcheck.sh", "--connect" ]
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
                                        timeoutSeconds = Some 5
                                      }
                                  )
                              , readinessProbe = Some
                                  (   execProbe [ "healthcheck.sh", "--connect" ]
                                    ⫽ { initialDelaySeconds = Some 10
                                      , periodSeconds = Some 5
                                      }
                                  )
                              , resources = Some d.resources
                              }
                          ]
                        , volumes = Some
                          [ { name = "data"
                            , persistentVolumeClaim = Some
                              { claimName = pvcName app }
                            , configMap = None { name : Text }
                            , emptyDir = None {}
                            , hostPath = None { path : Text, type : Text }
                            }
                          ]
                        }
                      }
                    }
                  }
                ]
          , None = [] : List K.Deployment
          }
          app.db

let dbService
    : T.App → List K.Service
    = λ(app : T.App) →
        merge
          { Some =
              λ(_ : T.Database) →
                [ { apiVersion = "v1"
                  , kind = "Service"
                  , metadata = meta (dbName app) app.name
                  , spec =
                    { -- headless; the app reaches it by name
                      clusterIP = Some "None"
                    , selector = appLabels (dbName app)
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
          app.db

let deploymentFor
    : T.Namespace → T.Workload → K.Deployment
    = λ(ns : T.Namespace) →
      λ(w : T.Workload) →
        let dataMounts =
              merge
                { Some =
                    λ(s : T.Storage) →
                      [ { name = dataVolumeName
                        , mountPath = s.mountPath
                        , subPath = s.subPath
                        , readOnly = None Bool
                        }
                      ]
                , None = [] : List K.VolumeMount
                }
                ns.storage

        let dataVolumes =
              merge
                { Some =
                    λ(_ : T.Storage) →
                      [ { name = dataVolumeName
                        , persistentVolumeClaim = Some
                          { claimName = dataPvcNameFor ns.name }
                        , configMap = None { name : Text }
                        , emptyDir = None {}
                        , hostPath = None { path : Text, type : Text }
                        }
                      ]
                , None = [] : List K.Volume
                }
                ns.storage

        let fsGroup =
            -- Only when there is a volume, and equal to the uid the container
            -- runs as. A PVC arrives owned by root, so without this the app is
            -- a non-root process holding a directory it cannot write — which
            -- surfaces as a permission error at the first upload rather than at
            -- startup, long after anyone would connect it to the manifest.
              merge
                { Some = λ(_ : T.Storage) → Some w.uid
                , None = None Natural
                }
                ns.storage

        let reachForbidsRolling =
            -- A `WireGuard` app is reached by a hostPort, and a second pod
            -- cannot bind a port the first one holds — so a rolling update does
            -- not merely risk two writers, it HANGS: the new pod stays Pending
            -- for ever while the old one is never torn down. A fact about the
            -- reach, read off the reach rather than offered as a field.
              merge
                { Ingress = λ(_ : { host : Text, exposure : T.Exposure }) → False
                , WireGuard = True
                , Internal = False
                }
                ns.reach

        let volumeForbidsRolling =
            -- And a fact about how the app WRITES, which no manifest can imply.
            -- ReadWriteOnce does not settle it: RWO restricts a claim to one
            -- NODE, both pods land on that node, so k8s permits both mounts and
            -- the rollout does not hang — it double-writes. See `T.Writers`.
              merge
                { Some =
                    λ(s : T.Storage) →
                      merge
                        { Exclusive = True
                        , Concurrent = λ(_ : { why : Text }) → False
                        }
                        s.writers
                , None = False
                }
                ns.storage

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
                , selector.matchLabels = appLabels w.name
                , template =
                  { metadata.labels = appLabels w.name
                  , spec =
                    { securityContext = podSecurityContext w.uid fsGroup
                    , restartPolicy = None Text
                    , containers =
                      [     baseContainer
                        ⫽ { name = w.name
                          , image = T.imageRef w.image
                          , imagePullPolicy = T.pullPolicyFor w.image
                          , command = w.command
                          , securityContext =
                              containerSecurityContext w.readOnlyRootFs
                          , ports =
                            [ merge
                                { Ingress =
                                    λ(_ : { host : Text, exposure : T.Exposure }) →
                                      { containerPort = w.port
                                      , hostPort = None Natural
                                      , hostIP = None Text
                                      }
                                , WireGuard =
                                    { containerPort = w.port
                                    , -- Same number by construction: a hostPort
                                      -- that disagrees with the containerPort
                                      -- forwards to nothing, silently.
                                      hostPort = Some w.port
                                    , hostIP = Some (T.wgAddress ns.cluster)
                                    }
                                , Internal =
                                    { containerPort = w.port
                                    , hostPort = None Natural
                                    , hostIP = None Text
                                    }
                                }
                                ns.reach
                            ]
                          , env =
                              L.nonEmpty
                                K.EnvVar
                                ( L.map
                                    T.EnvVar
                                    K.EnvVar
                                    (renderEnv (secretNameFor ns.name))
                                    w.env
                                )
                          , readinessProbe = Some
                              (   renderProbe w.probe
                                ⫽ { initialDelaySeconds = Some
                                      w.probeTiming.readiness.initialDelaySeconds
                                  , periodSeconds = Some
                                      w.probeTiming.readiness.periodSeconds
                                  }
                              )
                          , livenessProbe = Some
                              (   renderProbe w.probe
                                ⫽ { initialDelaySeconds = Some
                                      w.probeTiming.liveness.initialDelaySeconds
                                  , periodSeconds = Some
                                      w.probeTiming.liveness.periodSeconds
                                  }
                              )
                          , -- `T.Resources` requires both halves; `K.Resources`
                            -- makes `limits` Optional to match the API. Every
                            -- workload the fleet builds therefore renders
                            -- `Some`, and only a database may render `None`.
                            resources = Some
                              { requests = w.resources.requests
                              , limits = Some w.resources.limits
                              }
                          , volumeMounts =
                              L.nonEmpty
                                K.VolumeMount
                                (   L.map T.VolumeMount K.VolumeMount k8sMount w.mounts
                                  # dataMounts
                                )
                          }
                      ]
                    , volumes =
                        L.nonEmpty
                          K.Volume
                          (L.map T.Volume K.Volume k8sVolume w.volumes # dataVolumes)
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
let appDeployment
    : T.App → List K.Deployment
    = λ(app : T.App) → deployments (T.namespaceOf app)

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
    : T.App → Natural
    = λ(app : T.App) →
        merge
          { Ingress = λ(_ : { host : Text, exposure : T.Exposure }) → 80
          , WireGuard = app.workload.port
          , Internal = app.workload.port
          }
          app.reach

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
    : T.App → List K.CronJob
    = λ(app : T.App) →
        L.map
          T.ScheduledTask
          K.CronJob
          ( λ(t : T.ScheduledTask) →
              { apiVersion = "batch/v1"
              , kind = "CronJob"
              , metadata = meta t.name app.name
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
                , jobTemplate.spec =
                  { activeDeadlineSeconds = t.deadlineSeconds
                  , backoffLimit = None Natural
                  , template.spec =
                    { securityContext =
                        podSecurityContext app.workload.uid (None Natural)
                    , restartPolicy = Some "OnFailure"
                    , volumes = None (List K.Volume)
                    , containers =
                      [     baseContainer
                        ⫽ { name = t.name
                          , image = T.imageRef app.workload.image
                          , command = Some t.command
                          , securityContext =
                              containerSecurityContext
                                app.workload.readOnlyRootFs
                          , env = Some
                              ( L.map
                                  T.EnvVar
                                  K.EnvVar
                                  (renderEnv (secretName app))
                                  t.env
                              )
                          , resources = Some
                            { requests = t.resources.requests
                            , limits = Some t.resources.limits
                            }
                          }
                      ]
                    }
                  }
                }
              }
          )
          app.tasks

let appService
    : T.App → List K.Service
    = λ(app : T.App) →
        [ { apiVersion = "v1"
          , kind = "Service"
          , metadata = meta app.workload.name app.name
          , spec =
            { clusterIP = None Text
            , selector = appLabels app.workload.name
            , ports =
              [ { port = servicePort app
                , targetPort = Some app.workload.port
                , protocol = None Text
                }
              ]
            }
          }
        ]

let ingress
    : T.App → List K.Ingress
    = λ(app : T.App) →
        merge
          { Ingress =
              λ(r : { host : Text, exposure : T.Exposure }) →
                let host = r.host

                in  [ { apiVersion = "networking.k8s.io/v1"
                  , kind = "Ingress"
                  , metadata =
                        meta "${app.name}-ingress" app.name
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
                      [ { hosts = [ host ], secretName = "${app.name}-tls" } ]
                    , rules =
                      [ { host
                        , http.paths =
                          [ { path = "/"
                            , pathType = "Prefix"
                            , backend.service
                              = { name = app.workload.name
                                , port.number = servicePort app
                                }
                            }
                          ]
                        }
                      ]
                    }
                  }
                ]
          , WireGuard = [] : List K.Ingress
          , Internal = [] : List K.Ingress
          }
          app.reach

--| Only the app may reach the database. Rendered whenever the app has one, so
--  "namespace has a DB but nothing protecting it" is not a state this model can
--  produce.
let netpolDb
    : T.App → List K.NetworkPolicy
    = λ(app : T.App) →
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
                                  (List/length T.ScheduledTask app.tasks)
                          then  "${app.name}-db-from-app-only"
                          else  "${app.name}-db-from-namespace"
                        )
                        app.name
                  , spec =
                    { podSelector.matchLabels = Some (appLabels (dbName app))
                    , policyTypes = [ "Ingress" ]
                    , ingress = Some
                      [ { from =
                          [ { -- ⚠ AN APP WITH BATCH TASKS OPENS THIS TO THE
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
                                    if    Natural/isZero
                                            (List/length T.ScheduledTask app.tasks)
                                    then  Some (appLabels app.workload.name)
                                    else  None K.Labels
                                }
                            , namespaceSelector =
                                None { matchLabels : K.Labels }
                            }
                          ]
                        , ports = [ { port = 3306, protocol = None Text } ]
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
          app.db

--| ⚠️ HELD, not applied. k3s enforces NetworkPolicy via kube-router, which does
--  NOT exempt node-sourced kubelet probe traffic — applying this as written
--  drops the liveness/readiness probes, marks the pod NotReady and takes the
--  site down. Rendered to its own file so the intent stays reviewed, but it is
--  deliberately outside the applied set until a probe-source rule is added and
--  verified on a live pod.
let ingressFromNginx
    : T.App → K.NetworkPolicy
    = λ(app : T.App) →
        { apiVersion = "networking.k8s.io/v1"
        , kind = "NetworkPolicy"
        , metadata = meta "${app.name}-app-from-ingress-only" app.name
        , spec =
          { podSelector.matchLabels = Some (appLabels app.workload.name)
          , policyTypes = [ "Ingress" ]
          , ingress = Some
            [ { from =
                [ { podSelector = None { matchLabels : Optional K.Labels }
                  , -- Selected by the namespace's automatic
                    -- kubernetes.io/metadata.name label rather than chart pod
                    -- labels, which change across versions.
                    namespaceSelector = Some
                      { matchLabels =
                          toMap
                            { `kubernetes.io/metadata.name` = "ingress-nginx" }
                      }
                  }
                ]
              , ports =
                [ { port = app.workload.port, protocol = None Text } ]
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
    : T.App → List T.EgressTo → K.NetworkPolicy
    = λ(app : T.App) →
      λ(allowed : List T.EgressTo) →
        { apiVersion = "networking.k8s.io/v1"
        , kind = "NetworkPolicy"
        , metadata = meta "default-deny-egress" app.name
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
            egress =
              Some
              ( L.map
                T.EgressTo
                { to : List K.NetworkPolicyPeer
                , ports : List K.NetworkPolicyPort
                }
                ( λ(e : T.EgressTo) →
                    { to =
                      [ { podSelector = None { matchLabels : Optional K.Labels }
                        , namespaceSelector = Some
                          { matchLabels =
                              toMap { `kubernetes.io/metadata.name` = e.namespace }
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
    : T.App → List K.NetworkPolicy
    = λ(app : T.App) →
        merge
          { Unpoliced = [] : List K.NetworkPolicy
          , IngressFromNginx = [ ingressFromNginx app ]
          , Egress = λ(_ : List T.EgressTo) → [] : List K.NetworkPolicy
          }
          app.netpol

--| The APPLIED app policy, as opposed to the held one above.
let netpolApp
    : T.App → List K.NetworkPolicy
    = λ(app : T.App) →
        merge
          { Unpoliced = [] : List K.NetworkPolicy
          , IngressFromNginx = [] : List K.NetworkPolicy
          , Egress =
              λ(allowed : List T.EgressTo) → [ egressDefaultDeny app allowed ]
          }
          app.netpol

in  { storageWaiver
    , hostPathWaiver
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
    , clusterHost
    , hasDb
    , hasAppliedNetpol
    , usesHostPort
    }
