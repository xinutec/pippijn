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
let hasDb
    : T.App → Bool
    = λ(app : T.App) → merge { None = False, Some = λ(_ : T.Database) → True } app.db

let secretName = λ(app : T.App) → "${app.name}-secret"

let dbName = λ(app : T.App) → "${app.name}-db"

let pvcName = λ(app : T.App) → "${app.name}-db-pvc"

let dataPvcName = λ(app : T.App) → "${app.name}-data-pvc"

--| The pod-local name of the app's own volume. Distinct from the database's
--  `data` volume, which lives in a different pod entirely.
let dataVolumeName = "app-data"

let meta
    : Text → Text → K.Meta
    = λ(name : Text) →
      λ(ns : Text) →
        { name, namespace = Some ns, annotations = None Annotations }

let clusterMeta
    : Text → K.Meta
    = λ(name : Text) →
        { name, namespace = None Text, annotations = None Annotations }

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
          }
          e.value

let renderProbe
    : T.Probe → K.Probe
    = λ(p : T.Probe) →
        merge
          { Http = λ(h : K.HTTPGetAction) → K.emptyProbe ⫽ { httpGet = Some h }
          , Exec = λ(e : K.ExecAction) → K.emptyProbe ⫽ { exec = Some e }
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
      , ports = [] : List K.ContainerPort
      , env = [] : List K.EnvVar
      , volumeMounts = [] : List K.VolumeMount
      , startupProbe = None K.Probe
      , livenessProbe = None K.Probe
      , readinessProbe = None K.Probe
      }

let podSecurityContext
    : Natural → Optional Natural → K.PodSecurityContext
    = λ(uid : Natural) →
      λ(fsGroup : Optional Natural) →
        { runAsNonRoot = True
        , runAsUser = uid
        , runAsGroup = uid
        , fsGroup
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
                    , selector.matchLabels.app = dbName app
                    , template =
                      { metadata.labels.app = dbName app
                      , spec =
                        { -- The official image runs as uid 999 (mysql) when
                          -- started unprivileged; fsGroup keeps the data dir
                          -- writable.
                          securityContext = podSecurityContext 999 (Some 999)
                        , containers =
                          [     baseContainer
                            ⫽ { name = "mariadb"
                              , image = "mariadb:${mariadbVersion}"
                              , -- No readOnlyRootFilesystem: mariadb writes
                                -- /run/mysqld and its data dir.
                                securityContext = containerSecurityContext False
                              , env =
                                  L.map
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
                              , ports = [ { containerPort = 3306 } ]
                              , volumeMounts =
                                [ { name = "data"
                                  , mountPath = "/var/lib/mysql"
                                  , subPath = "mariadb-data"
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
                              , resources = d.resources
                              }
                          ]
                        , volumes =
                          [ { name = "data"
                            , persistentVolumeClaim.claimName = pvcName app
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
                    , selector.app = dbName app
                    , ports = [ { port = 3306, targetPort = Some 3306 } ]
                    }
                  }
                ]
          , None = [] : List K.Service
          }
          app.db

let appDeployment
    : T.App → List K.Deployment
    = λ(app : T.App) →
        let w = app.workload

        let dataMounts =
              merge
                { Some =
                    λ(s : T.Storage) →
                      [ { name = dataVolumeName
                        , mountPath = s.mountPath
                        , subPath = s.subPath
                        }
                      ]
                , None = [] : List K.VolumeMount
                }
                app.storage

        let dataVolumes =
              merge
                { Some =
                    λ(_ : T.Storage) →
                      [ { name = dataVolumeName
                        , persistentVolumeClaim.claimName = dataPvcName app
                        }
                      ]
                , None = [] : List K.Volume
                }
                app.storage

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
                app.storage

        in  [ { apiVersion = "apps/v1"
              , kind = "Deployment"
              , metadata = meta w.name app.name
              , spec =
                { replicas = 1
                , strategy = None { type : Text }
                , selector.matchLabels.app = w.name
                , template =
                  { metadata.labels.app = w.name
                  , spec =
                    { securityContext = podSecurityContext w.uid fsGroup
                    , containers =
                      [     baseContainer
                        ⫽ { name = w.name
                          , image = T.imageRef w.image
                          , command = w.command
                          , securityContext =
                              containerSecurityContext w.readOnlyRootFs
                          , ports = [ { containerPort = w.port } ]
                          , env =
                              L.map
                                T.EnvVar
                                K.EnvVar
                                (renderEnv (secretName app))
                                w.env
                          , readinessProbe = Some
                              (   renderProbe w.probe
                                ⫽ { initialDelaySeconds = Some 5
                                  , periodSeconds = Some 10
                                  }
                              )
                          , livenessProbe = Some
                              (   renderProbe w.probe
                                ⫽ { initialDelaySeconds = Some 15
                                  , periodSeconds = Some 20
                                  }
                              )
                          , resources = w.resources
                          , volumeMounts = w.mounts # dataMounts
                          }
                      ]
                    , volumes = dataVolumes
                    }
                  }
                }
              }
            ]

let appService
    : T.App → List K.Service
    = λ(app : T.App) →
        [ { apiVersion = "v1"
          , kind = "Service"
          , metadata = meta app.workload.name app.name
          , spec =
            { clusterIP = None Text
            , selector.app = app.workload.name
            , ports = [ { port = 80, targetPort = Some app.workload.port } ]
            }
          }
        ]

let ingress
    : T.App → List K.Ingress
    = λ(app : T.App) →
        merge
          { Some =
              λ(host : Text) →
                [ { apiVersion = "networking.k8s.io/v1"
                  , kind = "Ingress"
                  , metadata =
                        meta "${app.name}-ingress" app.name
                      ⫽ { annotations = Some
                            ( toMap
                                { `cert-manager.io/cluster-issuer` =
                                    "letsencrypt-prod"
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
                              = { name = app.workload.name, port.number = 80 }
                            }
                          ]
                        }
                      ]
                    }
                  }
                ]
          , None = [] : List K.Ingress
          }
          app.host

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
                  , metadata = meta "${app.name}-db-from-app-only" app.name
                  , spec =
                    { podSelector.matchLabels.app = dbName app
                    , policyTypes = [ "Ingress" ]
                    , ingress =
                      [ { from =
                          [ { podSelector = Some
                              { matchLabels.app = app.workload.name }
                            , namespaceSelector =
                                None { matchLabels : Annotations }
                            }
                          ]
                        , ports = [ { port = 3306 } ]
                        }
                      ]
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
let netpolAppHeld
    : T.App → List K.NetworkPolicy
    = λ(app : T.App) →
        if    app.netpol
        then  [ { apiVersion = "networking.k8s.io/v1"
                , kind = "NetworkPolicy"
                , metadata = meta "${app.name}-app-from-ingress-only" app.name
                , spec =
                  { podSelector.matchLabels.app = app.workload.name
                  , policyTypes = [ "Ingress" ]
                  , ingress =
                    [ { from =
                        [ { podSelector = None { matchLabels : K.Selector }
                          , -- Selected by the namespace's automatic
                            -- kubernetes.io/metadata.name label rather than
                            -- chart pod labels, which change across versions.
                            namespaceSelector = Some
                              { matchLabels =
                                  toMap
                                    { `kubernetes.io/metadata.name` =
                                        "ingress-nginx"
                                    }
                              }
                          }
                        ]
                      , ports = [ { port = app.workload.port } ]
                      }
                    ]
                  }
                }
              ]
        else  [] : List K.NetworkPolicy

in  { namespace
    , pvc
    , appPvc
    , dbDeployment
    , dbService
    , appDeployment
    , appService
    , ingress
    , netpolDb
    , netpolAppHeld
    , mariadbVersion
    , secretName
    , hasDb
    }
