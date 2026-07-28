-- home.xinutec.org — environmental readings + Claude usage dashboard.
let T = ../lib/types.dhall

let dns = ../dns.dhall

--| The app's secret, declared once.
--
-- Everything downstream refers to these as *fields* (`keys.INGEST_TOKEN`), so
-- a typo is a type error rather than a pod that starts with an unset variable
-- and fails an hour later. `toMap keys` below hands the same set to the App,
-- which is what `secret.sh` provisions — the two cannot drift apart.
let keys =
      { DB_USER = "DB_USER"
      , DB_PASSWORD = "DB_PASSWORD"
      , DB_ROOT_PASSWORD = "DB_ROOT_PASSWORD"
      , INGEST_TOKEN = "INGEST_TOKEN"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let lit = T.EnvValue.Literal

in    { name = "home"
      , cluster = T.Cluster.isis
      , db = Some
        { dbName = "home"
        , -- Readings are tiny (one small row every few minutes); 5Gi is years
          -- of headroom.
          storageGi = 5
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
        { name = "home"
        , image = T.Image.Fleet "home"
        , command = Some [ "node", "dist/server.js" ]
        , port = 3000
        , -- Matches the nonroot "node" user in the image.
          uid = 1000
        , readOnlyRootFs = False
        , env =
          [ { name = "PORT", value = lit "3000" }
          , { name = "DB_HOST", value = lit "home-db" }
          , { name = "DB_NAME", value = lit "home" }
          , { name = "DB_USER", value = secret keys.DB_USER }
          , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
          , { name = "INGEST_TOKEN", value = secret keys.INGEST_TOKEN }
          ]
        , probe = T.Probe.Http { path = "/health", port = 3000 }
        , resources =
          { requests = { cpu = "10m", memory = "128Mi" }
          , limits = { cpu = "200m", memory = "256Mi" }
          }
        , mounts = [] : List T.VolumeMount
        }
      , host = Some dns.home
      , secrets = toMap keys
      , netpol = False
      }
    : T.App
