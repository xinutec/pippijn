-- coach.xinutec.org — the training log (Rust/axum + Angular).
--
-- Shaped almost exactly like `life`: a MariaDB sidecar, Nextcloud sign-in, a
-- stateless read-only app container. The one thing that is its own is the pair
-- of `HEALTH_*` variables at the bottom — coach reads health-sync's internal API
-- to work out where a session happened, and that link is the only place in the
-- fleet where one app is a client of another.
let T = ../lib/types.dhall

let dns = ../dns.dhall

let keys =
      { DATABASE_URL = "DATABASE_URL"
      , DB_USER = "DB_USER"
      , DB_PASSWORD = "DB_PASSWORD"
      , DB_ROOT_PASSWORD = "DB_ROOT_PASSWORD"
      , SESSION_SECRET = "SESSION_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      , HEALTH_SERVICE_TOKEN = "HEALTH_SERVICE_TOKEN"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let optionalSecret =
      λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = True }

let lit = T.EnvValue.Literal

in    { name = "coach"
      , cluster = T.Cluster.isis
      , db = Some
        { dbName = "coach"
        , storageGi = 5
        , resources =
          { requests = { cpu = "50m", memory = "256Mi" }
          , limits = { cpu = "1", memory = "1Gi" }
          }
        , keys =
          { user = keys.DB_USER
          , password = keys.DB_PASSWORD
          , rootPassword = keys.DB_ROOT_PASSWORD
          }
        }
      , storage = None T.Storage
      , workload =
        { name = "coach-app"
        , image = T.Image.Fleet "coach"
        , command = None (List Text)
        , port = 8080
        , -- Matches the nonroot user baked into the image (Dockerfile).
          uid = 65532
        , -- The app never writes to disk.
          readOnlyRootFs = True
        , env =
          [ { -- Full mysql:// DSN (carries the DB password) — kept whole.
              name = "DATABASE_URL"
            , value = secret keys.DATABASE_URL
            }
          , { name = "SESSION_SECRET", value = secret keys.SESSION_SECRET }
          , { name = "NC_BASE_URL", value = lit "https://${dns.dash}" }
          , { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
          , { -- Derived from the same hostname the Ingress serves, so the
              -- OAuth callback cannot drift from where the app actually lives.
              name = "NC_REDIRECT_URI"
            , value = lit "https://${dns.coach}/auth/callback"
            }
          , { -- info = one line per /api request (TraceLayer); coach=debug adds
              -- our own low-volume detail. Third-party crates stay at info.
              name = "RUST_LOG"
            , value = lit "info,coach=debug"
            }
          , { -- health-sync's internal API, in-cluster. Not the public name:
              -- health.xinutec.org resolves to this node's own public address
              -- and a pod cannot open a connection to it — the packet hairpins
              -- and is refused. This is the Service, so the call never leaves
              -- the cluster and never meets the ingress' sign-in wall.
              name = "HEALTH_INTERNAL_URL"
            , value = lit "http://health-auth.health.svc.cluster.local"
            }
          , { -- What coach presents to health. Optional, and deliberately so:
              -- unset, location auto-detect for a session is off and picking the
              -- venue by hand still works. `secret.sh` does not write this key —
              -- the feature is opt-in per deployment, and a required reference
              -- would leave the pod unable to start until someone did.
              name = "HEALTH_SERVICE_TOKEN"
            , value = optionalSecret keys.HEALTH_SERVICE_TOKEN
            }
          ]
        , probeTiming = T.standardTiming
        , probe = T.Probe.Http { path = "/healthz", port = 8080 }
        , resources =
          { requests = { cpu = "50m", memory = "64Mi" }
          , limits = { cpu = "1", memory = "256Mi" }
          }
        , volumes = [] : List T.Volume
        , mounts = [] : List T.VolumeMount
        }
      , reach = T.Reach.Ingress
        { host = dns.coach, exposure = T.Exposure.Public }
      , secrets = toMap keys
      , netpol = T.Netpol.IngressFromNginx
      }
    : T.App
