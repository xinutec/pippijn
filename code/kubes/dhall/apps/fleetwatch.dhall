-- fleetwatch.xinutec.org — where the fleet's machines report what they saw
-- (Rust/axum + Angular).
--
-- Two audiences, two gates, and the model only expresses one of them. The WRITE
-- path is token-only: `FLEETWATCH_TOKENS` is a comma-separated set of
-- source:token pairs, and a producer can only ever write as its mapped source
-- (`src/auth.rs`). Reads sit behind the Nextcloud login, with one hole —
-- `FLEETWATCH_READ_TOKENS` opens `GET /api/problems` alone, for the Android
-- app's half-hourly background poller. Both are secret references here; which
-- endpoints they unlock is the app's business and is written up beside the code.
let T = ../lib/types.dhall

let dns = ../dns.dhall

let keys =
      { DATABASE_URL = "DATABASE_URL"
      , DB_USER = "DB_USER"
      , DB_PASSWORD = "DB_PASSWORD"
      , DB_ROOT_PASSWORD = "DB_ROOT_PASSWORD"
      , FLEETWATCH_TOKENS = "FLEETWATCH_TOKENS"
      , FLEETWATCH_READ_TOKENS = "FLEETWATCH_READ_TOKENS"
      , SESSION_SECRET = "SESSION_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let optionalSecret =
      λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = True }

let lit = T.EnvValue.Literal

in    { name = "fleetwatch"
      , cluster = T.Cluster.isis
      , db = Some
        { dbName = "fleetwatch"
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
        { name = "fleetwatch-app"
        , image = T.Image.Fleet "fleetwatch"
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
          , { -- The ingest credentials: comma-separated source:token pairs. A
              -- producer can only ever write as its mapped source.
              name = "FLEETWATCH_TOKENS"
            , value = secret keys.FLEETWATCH_TOKENS
            }
          , { -- Read token(s) for unattended readers — today the Android app's
              -- background poller, which asks GET /api/problems every 30 min and
              -- raises a notification when the answer changes. That ONE endpoint;
              -- every other read stays behind the Nextcloud login. Optional, and
              -- it has to be: unset simply means no unattended reader, which is a
              -- fleet with no phone in it rather than a broken one.
              name = "FLEETWATCH_READ_TOKENS"
            , value = optionalSecret keys.FLEETWATCH_READ_TOKENS
            }
          , { -- Human auth. Session cookies are HMAC-signed with this; the ingest
              -- path above stays token-only and never sees a session.
              name = "SESSION_SECRET"
            , value = secret keys.SESSION_SECRET
            }
          , { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
          , { name = "NC_BASE_URL", value = lit "https://${dns.dash}" }
          , { -- Derived from the same hostname the Ingress serves, so the OAuth
              -- callback cannot drift from where the app actually lives.
              name = "NC_REDIRECT_URI"
            , value = lit "https://${dns.fleetwatch}/auth/callback"
            }
          , { -- info = one line per /api request (TraceLayer); fleetwatch=debug
              -- adds our own ingest detail. Third-party crates stay at info.
              name = "RUST_LOG"
            , value = lit "info,fleetwatch=debug"
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
      , -- The hostname resolves to isis's WireGuard address, not the public one,
        -- so HTTP-01 cannot validate and the certificate must come from DNS-01 —
        -- which is what this field decides.
        --
        -- ⚠ Obscurity, NOT a firewall: the isis ingress answers on the public IP
        -- too. The real gate on the WRITE path is the ingest bearer token. A
        -- `whitelist-source-range: 10.100.0.0/24` annotation was tried and
        -- REMOVED (2026-07-03): behind k3s servicelb the client's WireGuard
        -- source IP is SNAT'd before nginx sees it, so the rule 403s a legitimate
        -- VPN client. Making the source IP survive needs a cluster-wide ingress
        -- change (externalTrafficPolicy: Local + forwarded-headers) affecting
        -- every service, and is deliberately not done.
        reach = T.Reach.Ingress
          { host = dns.fleetwatch, exposure = T.Exposure.VpnOnly }
      , secrets = toMap keys
      , netpol = True
      }
    : T.App
