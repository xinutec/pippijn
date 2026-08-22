-- home.xinutec.org — environmental readings + Claude usage dashboard.
let T = ../lib/types.dhall

let dns = ../dns.dhall

let keys =
      { DB_USER = "DB_USER"
      , DB_PASSWORD = "DB_PASSWORD"
      , DB_ROOT_PASSWORD = "DB_ROOT_PASSWORD"
      , INGEST_TOKEN = "INGEST_TOKEN"
      , SESSION_SECRET = "SESSION_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let lit = T.EnvValue.Literal

in  T.namespaceOf
      (     { name = "home"
      , cluster = T.Cluster.isis
      , db = Some
        { dbName = "home"
        , innodbBufferPoolGi = None Natural
        , -- Readings are tiny (one small row every few minutes); 5Gi is years
          -- of headroom.
          storageGi = 5
        , resources =
          { requests = { cpu = "50m", memory = "256Mi" }
          , limits = Some { cpu = Some "1", memory = "1Gi" }
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
            T.Reach.Ingress { host = dns.home, exposure = T.Exposure.Public }
        , name = "home"
        , image = T.Image.Fleet "home"
        , command = Some [ "node", "dist/server.js" ]
        , port = 3000
        , -- Matches the nonroot "node" user in the image.
          uid = 1000
        , hardening = T.Hardening.NonRoot
        , -- Nothing in the server writes to disk: state is the database and
          -- the session cookie, and `src/` has no `writeFile`,
          -- `createWriteStream` or `mkdir`. It was `False` and said nothing
          -- about why, which went unnoticed because dev-lint carved
          -- `xinutec/home` out of DL-K8S-ROOTFS-RW by name until 2026-08-12.
          rootFs = T.RootFs.ReadOnly
        , env =
          [ { name = "PORT", value = lit "3000" }
          , { name = "DB_HOST", value = lit "home-db" }
          , { name = "DB_NAME", value = lit "home" }
          , { name = "DB_USER", value = secret keys.DB_USER }
          , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
          , { name = "INGEST_TOKEN", value = secret keys.INGEST_TOKEN }
          , { name = "SESSION_SECRET", value = secret keys.SESSION_SECRET }
          , { name = "NC_BASE_URL", value = lit "https://dash.xinutec.org" }
          , { name = "NC_REDIRECT_URI"
            , value = lit "https://home.xinutec.org/auth/callback"
            }
          , { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
          ]
        , readiness = None T.Readiness
        , probeTiming = T.standardTiming
        , probe = T.Probe.Http { path = "/health", port = 3000 }
        , resources =
          { requests = { cpu = "10m", memory = "128Mi" }
          , limits = Some { cpu = Some "200m", memory = "256Mi" }
          }
        , volumes = [] : List T.Volume
        , mounts = [] : List T.VolumeMount
        , tasks = [] : List T.ScheduledTask
        }
      , secrets = toMap keys
      , netpol = T.Netpol.Unpoliced
      }
          : T.App
      )
