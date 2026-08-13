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

let mariadbVersion = "12.3"

let Annotations = List { mapKey : Text, mapValue : Text }

let hasAppliedNetpol
    : T.App → Bool
    = λ(app : T.App) →
        merge
          { Unpoliced = False
          , IngressFromNginx = False
          , Egress = λ(_ : List T.EgressTo) → True
          }
          app.netpol

let usesHostPort
    : T.App → Bool
    = λ(app : T.App) →
        merge
          { Ingress = λ(_ : { host : Text, exposure : T.Exposure }) → False
          , WireGuard = True
          , Internal = False
          , NoService = False
          }
          app.workload.reach

let hasDb
    : T.App → Bool
    = λ(app : T.App) →
        merge { None = False, Some = λ(_ : T.Database) → True } app.db

let clusterHost
    : T.App → Text
    = λ(app : T.App) →
        merge
          { isis = "isis.xinutec.org", amun = "amun.xinutec.org" }
          app.cluster

let secretNameFor = λ(name : Text) → "${name}-secret"

let dbNameFor = λ(name : Text) → "${name}-db"

let pvcNameFor = λ(name : Text) → "${name}-db-pvc"

let dataPvcNameFor = λ(name : Text) → "${name}-data-pvc"

let secretName = λ(app : T.App) → secretNameFor app.name

let dbName = λ(app : T.App) → dbNameFor app.name

let pvcName = λ(app : T.App) → pvcNameFor app.name

let dataPvcName = λ(app : T.App) → dataPvcNameFor app.name

let dataVolumeName = "app-data"

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
          , Tcp =
              λ(t : K.TCPSocketAction) → K.emptyProbe ⫽ { tcpSocket = Some t }
          }
          p

let execProbe
    : List Text → K.Probe
    = λ(cmd : List Text) → K.emptyProbe ⫽ { exec = Some { command = cmd } }

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
                      empty
                    ⫽ { hostPath = Some { path = h.path, type = "Directory" } }
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
                        , HostPath =
                            λ(h : { path : Text, why : Text }) → [ h.why ]
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
                      strategy = Some
                      { type = "Recreate" }
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
                      clusterIP = Some
                        "None"
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
                { Some = λ(_ : T.Storage) → Some w.uid, None = None Natural }
                ns.storage

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
                , Internal = False
                , NoService = False
                }
                w.reach

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
                    [   baseContainer
                      ⫽ { name = w.name
                        , image = T.imageRef w.image
                        , imagePullPolicy = T.pullPolicyFor w.image
                        , command = w.command
                        , securityContext =
                            containerSecurityContext w.readOnlyRootFs
                        , ports =
                          [ merge
                              { Ingress =
                                  λ ( _
                                    : { host : Text, exposure : T.Exposure }
                                    ) →
                                    { containerPort = w.port
                                    , hostPort = None Natural
                                    , hostIP = None Text
                                    }
                              , WireGuard =
                                { containerPort = w.port
                                , -- Same number by construction: a hostPort
                                  -- that disagrees with the containerPort
                                  -- forwards to nothing, silently.
                                  hostPort = Some
                                    w.port
                                , hostIP = Some (T.wgAddress ns.cluster)
                                }
                              , Internal =
                                { containerPort = w.port
                                , hostPort = None Natural
                                , hostIP = None Text
                                }
                              , NoService =
                                { containerPort = w.port
                                , hostPort = None Natural
                                , hostIP = None Text
                                }
                              }
                              w.reach
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
                              (   L.map
                                    T.VolumeMount
                                    K.VolumeMount
                                    k8sMount
                                    w.mounts
                                # dataMounts
                              )
                        }
                    ]
                  , volumes =
                      L.nonEmpty
                        K.Volume
                        (   L.map T.Volume K.Volume k8sVolume w.volumes
                          # dataVolumes
                        )
                  }
                }
              }
            }

let deployments
    : T.Namespace → List K.Deployment
    = λ(ns : T.Namespace) →
        L.map T.Workload K.Deployment (deploymentFor ns) ns.workloads

let appDeployment
    : T.App → List K.Deployment
    = λ(app : T.App) → deployments (T.namespaceOf app)

let servicePort
    : T.Workload → Natural
    = λ(w : T.Workload) →
        merge
          { Ingress = λ(_ : { host : Text, exposure : T.Exposure }) → 80
          , WireGuard = w.port
          , Internal = w.port
          , -- Never evaluated: `serviceFor` renders no Service for this arm, so
            -- the port is not a fallback anybody can reach. Stated rather than
            -- left to a wildcard so adding a fifth arm stays a type error.
            NoService = w.port
          }
          w.reach

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
                , jobTemplate.spec
                  =
                  { activeDeadlineSeconds = t.deadlineSeconds
                  , backoffLimit = None Natural
                  , template.spec
                    =
                    { securityContext =
                        podSecurityContext app.workload.uid (None Natural)
                    , restartPolicy = Some "OnFailure"
                    , volumes = None (List K.Volume)
                    , containers =
                      [   baseContainer
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
                  , selector = appLabels w.name
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
              , NoService = [] : List K.Service
              }
              w.reach

let services
    : T.Namespace → List K.Service
    = λ(ns : T.Namespace) →
        L.concatMap T.Workload K.Service (serviceFor ns) ns.workloads

let appService
    : T.App → List K.Service
    = λ(app : T.App) → services (T.namespaceOf app)

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
                            meta "${ns.name}-ingress" ns.name
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
                          [ { hosts = [ host ], secretName = "${ns.name}-tls" }
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
          , NoService = [] : List K.Ingress
          }
          w.reach

let ingresses
    : T.Namespace → List K.Ingress
    = λ(ns : T.Namespace) →
        L.concatMap T.Workload K.Ingress (ingressFor ns) ns.workloads

let ingress
    : T.App → List K.Ingress
    = λ(app : T.App) → ingresses (T.namespaceOf app)

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
                                          ( List/length
                                              T.ScheduledTask
                                              app.tasks
                                          )
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
                    { matchLabels = toMap
                        { `kubernetes.io/metadata.name` = "ingress-nginx" }
                    }
                  }
                ]
              , ports = [ { port = app.workload.port, protocol = None Text } ]
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
            egress = Some
              ( L.map
                  T.EgressTo
                  { to : List K.NetworkPolicyPeer
                  , ports : List K.NetworkPolicyPort
                  }
                  ( λ(e : T.EgressTo) →
                      { to =
                        [ { podSelector =
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

let netpolAppHeld
    : T.App → List K.NetworkPolicy
    = λ(app : T.App) →
        merge
          { Unpoliced = [] : List K.NetworkPolicy
          , IngressFromNginx = [ ingressFromNginx app ]
          , Egress = λ(_ : List T.EgressTo) → [] : List K.NetworkPolicy
          }
          app.netpol

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
