-- The typed fleet model.
--
-- This file is the schema every app is written against. The point of putting
-- it in Dhall rather than YAML is that the invariants below stop being things
-- a linter re-derives after the fact and start being things the type checker
-- refuses to let you write:
--
--   * a fleet image cannot carry a version tag (see `Image`)
--   * an env var is either a literal or a secret reference, never ambiguous
--   * a secret key is a *record field*, so a typo is a type error, not a pod
--     that boots with an empty password (see `apps/*.dhall`)
--   * a container must state its resource limits
--
-- Nothing here performs IO. Rendering a manifest is pure evaluation, which is
-- why `generate.sh --check` can be trusted as a dry run.

--| Which k3s cluster an app is scheduled on.
let Cluster = < isis | amun >

let Image =
      < Fleet : Text | Upstream : { repo : Text, tag : Text } | Local : Text >

let imageRef
    : Image → Text
    = λ(i : Image) →
        merge
          { Fleet = λ(name : Text) → "xinutec/${name}:latest"
          , Upstream = λ(u : { repo : Text, tag : Text }) → "${u.repo}:${u.tag}"
          , Local = λ(name : Text) → "docker.io/xinutec/${name}:local"
          }
          i

let pullPolicyFor
    : Image → Optional Text
    = λ(i : Image) →
        merge
          { Fleet = λ(_ : Text) → None Text
          , Upstream = λ(_ : { repo : Text, tag : Text }) → None Text
          , Local = λ(_ : Text) → Some "Never"
          }
          i

let EnvValue =
      < Literal : Text
      | FromSecret : { key : Text, optional : Bool }
      | FromUnmanagedSecret : { secret : Text, key : Text, optional : Bool }
      >

let EnvVar = { name : Text, value : EnvValue }

let Probe =
      < Http : { path : Text, port : Natural }
      | Exec : { command : List Text }
      | Tcp : { port : Natural }
      >

let ProbeTiming =
      { readiness : { initialDelaySeconds : Natural, periodSeconds : Natural }
      , liveness : { initialDelaySeconds : Natural, periodSeconds : Natural }
      }

let standardTiming
    : ProbeTiming
    = { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
      , liveness = { initialDelaySeconds = 15, periodSeconds = 20 }
      }

let Quantity = { cpu : Text, memory : Text }

let Resources = { requests : Quantity, limits : Quantity }

let DbResources = { requests : Quantity, limits : Optional Quantity }

let VolumeMount =
      { name : Text
      , mountPath : Text
      , subPath : Optional Text
      , readOnly : Bool
      }

let Durability = < BackedUp | LossAccepted : { why : Text } >

let Writers = < Exclusive | Concurrent : { why : Text } >

let Claim =
      { name : Text
      , storageGi : Natural
      , durability : Durability
      , writers : Writers
      }

let Storage =
      { storageGi : Natural
      , mountPath : Text
      , -- Optional for the reason `VolumeMount.subPath` is — adding one to a
        -- live mount hides the data that was there.
        subPath : Optional Text
      , durability : Durability
      , writers : Writers
      }

let VolumeSource =
      < EmptyDir
      | ConfigMap : { name : Text }
      | HostPath : { path : Text, why : Text }
      | Claim : Claim
      >

let Volume = { name : Text, source : VolumeSource }

let Exposure = < Public | VpnOnly >

let issuerFor
    : Exposure → Text
    = λ(e : Exposure) →
        merge { Public = "letsencrypt-prod", VpnOnly = "letsencrypt-dns" } e

let Reach =
      < Ingress : { host : Text, exposure : Exposure }
      | WireGuard
      | Internal
      | NoService
      >

let Workload =
      { name : Text
      , -- How anything outside this pod gets to it. ON THE WORKLOAD, not the
        -- namespace: signal runs a REST bridge (Internal), an archiver
        -- (NoService) and, in another repo tree entirely, a viewer (Ingress).
        reach : Reach
      , image : Image
      , command : Optional (List Text)
      , port : Natural
      , uid : Natural
      , readOnlyRootFs : Bool
      , env : List EnvVar
      , probe : Probe
      , probeTiming : ProbeTiming
      , resources : Resources
      , volumes : List Volume
      , mounts : List VolumeMount
      }

let Database =
      { dbName : Text
      , storageGi : Natural
      , -- InnoDB's buffer pool, in GiB. `None` leaves the engine default, which
        -- is 128 MiB — fine for the five small databases and catastrophic for
        -- the one that is not.
        --
        -- ⚠ A FIELD RATHER THAN A FREE `args` LIST, because it is the one server
        -- flag the fleet sets and the one that must not drift from
        -- `resources.requests.memory`: the pool is resident, so a request that
        -- does not cover it is a pod the scheduler places on a node that cannot
        -- hold it. health-db is `Some 2` against a 2304Mi request — 2 GiB of
        -- pool plus mariadbd overhead.
        --
        -- It exists because `--check` caught its absence: rendering health-db
        -- without it silently cut a 4 GB database's pool by 16x, which is not a
        -- failure any manifest review would have seen.
        innodbBufferPoolGi : Optional Natural
      , resources : DbResources
      , keys : { user : Text, password : Text, rootPassword : Text }
      }

let wgAddress
    : Cluster → Text
    = λ(c : Cluster) → merge { isis = "10.100.0.2", amun = "10.100.0.1" } c

let SecretKey = { mapKey : Text, mapValue : Text }

let EgressTo =
      { namespace : Text, ports : List { port : Natural, protocol : Text } }

let Netpol = < Unpoliced | IngressFromNginx | Egress : List EgressTo >

let ConfigMapDoc =
      { name : Text, files : List { mapKey : Text, mapValue : Text } }

let ScheduledTask =
      { name : Text
      , -- `*/15 * * * *`. In the cluster's timezone, which is UTC.
        schedule : Text
      , command : List Text
      , deadlineSeconds : Natural
      , -- Defined but not running. Kubernetes keeps this in `spec.suspend`, and
        -- it is the field most likely to exist ONLY in the cluster: suspending
        -- is what you do from a terminal at the moment something misbehaves, and
        -- `kubectl patch` leaves no trace in any repo.
        --
        -- ⚠ health-bus-refresh was found exactly that way on 2026-08-13 —
        -- suspended in the cluster, no `suspend:` in its manifest, and never run
        -- in the 62 days since it was created. A model that omitted the field
        -- would have declared a daily job that does not run, which is worse than
        -- the drift it replaced: it would read as reviewed.
        suspended : Bool
      , env : List EnvVar
      , resources : Resources
      }

let Namespace =
      { name : Text
      , cluster : Cluster
      , db : Optional Database
      , configMap : Optional ConfigMapDoc
      , claims : List Claim
      , workloads : List Workload
      , tasks : List ScheduledTask
      , secrets : List SecretKey
      , netpol : Netpol
      }

let App =
      { name : Text
      , cluster : Cluster
      , db : Optional Database
      , storage : Optional Storage
      , configMap : Optional ConfigMapDoc
      , workload : Workload
      , -- Batch work sharing this app's image, namespace and database. Empty for
        -- every app but health.
        tasks : List ScheduledTask
      , secrets : List SecretKey
      , netpol : Netpol
      }

let namespaceOf
    : App → Namespace
    = λ(a : App) →
        let dataVolumeName = "app-data"

        let claimName = "${a.name}-data-pvc"

        let claimOf =
              λ(s : Storage) →
                { name = claimName
                , storageGi = s.storageGi
                , durability = s.durability
                , writers = s.writers
                }

        let claims =
              merge
                { None = [] : List Claim
                , Some = λ(s : Storage) → [ claimOf s ]
                }
                a.storage

        let extraVolumes =
              merge
                { None = [] : List Volume
                , Some =
                    λ(s : Storage) →
                      [ { name = dataVolumeName
                        , source = VolumeSource.Claim (claimOf s)
                        }
                      ]
                }
                a.storage

        let extraMounts =
              merge
                { None = [] : List VolumeMount
                , Some =
                    λ(s : Storage) →
                      [ { name = dataVolumeName
                        , mountPath = s.mountPath
                        , subPath = s.subPath
                        , readOnly = False
                        }
                      ]
                }
                a.storage

        in    a.{ name, cluster, db, configMap, tasks, secrets, netpol }
            ⫽ { claims
              , workloads =
                [   a.workload
                  ⫽ { volumes = a.workload.volumes # extraVolumes
                    , mounts = a.workload.mounts # extraMounts
                    }
                ]
              }

in  { Cluster
    , Durability
    , Image
    , imageRef
    , pullPolicyFor
    , EnvValue
    , EnvVar
    , Probe
    , ProbeTiming
    , standardTiming
    , Quantity
    , Resources
    , DbResources
    , ConfigMapDoc
    , VolumeMount
    , VolumeSource
    , Volume
    , Claim
    , Writers
    , Storage
    , Workload
    , ScheduledTask
    , Namespace
    , namespaceOf
    , Database
    , SecretKey
    , Exposure
    , issuerFor
    , wgAddress
    , Reach
    , Netpol
    , EgressTo
    , App
    }
