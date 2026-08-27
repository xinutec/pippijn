let T =
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
      ../lib/types.dhall

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

in  T.namespaceOf
      (     { name = "fleetwatch"
      , placement = T.on T.Cluster.isis
      , db = Some
        { dbName = "fleetwatch"
        , innodbBufferPoolGi = None Natural
        , storageGi = 5
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
        T.Workload::{ name = "fleetwatch-app"
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
          reach =
            T.Reach.Ingress
              { host = dns.fleetwatch, exposure = T.Exposure.VpnOnly }
        , image = T.Image.Fleet "fleetwatch"
        , port = 8080
        , -- Matches the nonroot user baked into the image (Dockerfile).
          uid = 65532
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- The app never writes to disk.
          rootFs = T.RootFs.ReadOnly
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
        , -- ⚠ THE TWO PROBES ASK DIFFERENT QUESTIONS, and they used to ask the
          -- same one. `/healthz` returns the literal `"ok"`, which is the right
          -- answer for liveness and a lie for readiness: it proved the process
          -- was listening and nothing else, so a pod that could not reach its
          -- database — or had exhausted its pool, which is what #1053 was —
          -- reported Ready and kept taking traffic it answered with 500s.
          --
          -- `/readyz` runs `SELECT 1` through the SHARED pool, so it asks for a
          -- connection exactly the way a real handler does and an exhausted pool
          -- reads as unready even while MariaDB itself is healthy. Liveness stays
          -- on `/healthz` on purpose: readiness withdraws the pod and puts it
          -- back by itself, where liveness would restart the container in a loop
          -- for as long as the database was down.
          --
          -- The timings are the single-replica tax. `timeoutSeconds = 5` sits
          -- above the handler's own 3s budget (`routes::health::READY_BUDGET`),
          -- so a slow database arrives as a 503 fleetwatch logged rather than a
          -- probe timeout that names no cause; `failureThreshold = 3` with a 10s
          -- period means 30s of sustained failure before the only pod leaves the
          -- Service. Both exist because unreadying this app is an OUTAGE, not a
          -- shift of traffic to a sibling.
          readiness = Some
          { probe = T.Probe.Http { path = "/readyz", port = 8080 }
          , timeoutSeconds = 5
          , failureThreshold = 3
          }
        , resources =
          { requests = { cpu = "50m", memory = "64Mi" }
          , limits = Some { cpu = Some "1", memory = "256Mi" }
          }
        , volumes = [] : List T.Volume
        , mounts = [] : List T.VolumeMount
        }
      , secrets = toMap keys
      , netpol = T.Netpol.IngressFromNginx
      }
          : T.App
      )
