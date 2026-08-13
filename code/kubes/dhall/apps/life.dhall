-- life.xinutec.org — the life app (Rust/axum + Angular).
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
      , EMOTION_WORKER_TOKEN = "EMOTION_WORKER_TOKEN"
      , BINS_ICAL_URL = "BINS_ICAL_URL"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let optionalSecret =
      λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = True }

let lit = T.EnvValue.Literal

in    { name = "life"
      , cluster = T.Cluster.isis
      , db = Some
        { dbName = "life"
        , innodbBufferPoolGi = None Natural
        , storageGi = 5
        , resources =
          { requests = { cpu = "50m", memory = "256Mi" }
          , limits = Some { cpu = "1", memory = "1Gi" }
          }
        , keys =
          { user = keys.DB_USER
          , password = keys.DB_PASSWORD
          , rootPassword = keys.DB_ROOT_PASSWORD
          }
        }
      , storage = None T.Storage
      , -- Configured entirely from the environment; no files to mount.
        configMap = None T.ConfigMapDoc
      , workload =
        { reach =
            T.Reach.Ingress { host = dns.life, exposure = T.Exposure.Public }
        , name = "life-app"
        , image = T.Image.Fleet "life"
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
            , value = lit "https://${dns.life}/auth/callback"
            }
          , { -- info = one line per /api request (TraceLayer); life=debug adds
              -- our own low-volume sync/product detail. Third-party crates stay
              -- at info (quiet).
              name = "RUST_LOG"
            , value = lit "info,life=debug"
            }
          , { -- Emotion suggestions. The model is MLX on the Mac and the note
              -- never leaves your kit — but this pod may not dial the Mac
              -- (one-way WireGuard peer), so the Mac's worker dials IN and this
              -- is the shared secret it authenticates with. Unset → no worker
              -- channel, and the picker is just the plain wheel. Optional so the
              -- pod still starts before the key exists.
              name = "EMOTION_WORKER_TOKEN"
            , value = optionalSecret keys.EMOTION_WORKER_TOKEN
            }
          , { -- The council's bin-collection iCal subscription. A SECRET rather
              -- than a plain value, though the feed itself is public and needs
              -- no auth: the URL carries a property id that identifies one
              -- address, and this repository is public. Optional so the pod
              -- starts without it — unset simply means no bin card.
              name = "BINS_ICAL_URL"
            , value = optionalSecret keys.BINS_ICAL_URL
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
        , tasks = [] : List T.ScheduledTask
        }
      , secrets = toMap keys
      , netpol = T.Netpol.IngressFromNginx
      }
    : T.App
