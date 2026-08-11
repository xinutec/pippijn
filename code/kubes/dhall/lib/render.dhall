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

let secretName = λ(app : T.App) → "${app.name}-secret"

let dbName = λ(app : T.App) → "${app.name}-db"

let pvcName = λ(app : T.App) → "${app.name}-db-pvc"

let dataPvcName = λ(app : T.App) → "${app.name}-data-pvc"

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
      , imagePullPolicy = None Text
      , ports = [] : List K.ContainerPort
      , env = [] : List K.EnvVar
      , volumeMounts = [] : List K.VolumeMount
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
                              , ports =
                                [ { containerPort = 3306
                                  , hostPort = None Natural
                                  , hostIP = None Text
                                  }
                                ]
                              , volumeMounts =
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
                        , volumes =
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
                        , readOnly = None Bool
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
                        , persistentVolumeClaim = Some
                          { claimName = dataPvcName app }
                        , configMap = None { name : Text }
                        , emptyDir = None {}
                        , hostPath = None { path : Text, type : Text }
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
                app.reach

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
                app.storage

        let strategy =
              if    reachForbidsRolling || volumeForbidsRolling
              then  Some { type = "Recreate" }
              else  None { type : Text }

        in  [ { apiVersion = "apps/v1"
              , kind = "Deployment"
              , metadata = meta w.name app.name
              , spec =
                { replicas = 1
                , strategy
                , selector.matchLabels = appLabels w.name
                , template =
                  { metadata.labels = appLabels w.name
                  , spec =
                    { securityContext = podSecurityContext w.uid fsGroup
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
                                    , hostIP = Some (T.wgAddress app.cluster)
                                    }
                                , Internal =
                                    { containerPort = w.port
                                    , hostPort = None Natural
                                    , hostIP = None Text
                                    }
                                }
                                app.reach
                            ]
                          , env =
                              L.map
                                T.EnvVar
                                K.EnvVar
                                (renderEnv (secretName app))
                                w.env
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
                          , resources = Some w.resources
                          , volumeMounts = L.map T.VolumeMount K.VolumeMount k8sMount w.mounts # dataMounts
                          }
                      ]
                    , volumes =
                        L.map T.Volume K.Volume k8sVolume w.volumes # dataVolumes
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
            , selector = appLabels app.workload.name
            , ports =
              [ { port = 80
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
                              = { name = app.workload.name, port.number = 80 }
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
                  , metadata = meta "${app.name}-db-from-app-only" app.name
                  , spec =
                    { podSelector.matchLabels = Some (appLabels (dbName app))
                    , policyTypes = [ "Ingress" ]
                    , ingress =
                      [ { from =
                          [ { podSelector = Some
                              { matchLabels = appLabels app.workload.name }
                            , namespaceSelector =
                                None { matchLabels : K.Labels }
                            }
                          ]
                        , ports = [ { port = 3306, protocol = None Text } ]
                        }
                      ]
                    , egress =
                        [] : List
                               { to : List K.NetworkPolicyPeer
                               , ports : List K.NetworkPolicyPort
                               }
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
          , ingress =
            [ { from =
                [ { podSelector = None { matchLabels : K.Labels }
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
              [] : List
                     { to : List K.NetworkPolicyPeer
                     , ports : List K.NetworkPolicyPort
                     }
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
          , ingress =
              [] : List
                     { from : List K.NetworkPolicyPeer
                     , ports : List K.NetworkPolicyPort
                     }
          , egress =
              L.map
                T.EgressTo
                { to : List K.NetworkPolicyPeer
                , ports : List K.NetworkPolicyPort
                }
                ( λ(e : T.EgressTo) →
                    { to =
                      [ { podSelector = None { matchLabels : K.Labels }
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
    , namespace
    , pvc
    , appPvc
    , dbDeployment
    , dbService
    , appDeployment
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
    }
