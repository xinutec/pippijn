-- tasks.xinutec.org — the work Claude sessions and Pippijn hand between each
-- other (Rust axum + Angular). Repo: github.com/xinutec/tasks.
--
-- Two things about this app decide most of what follows.
--
-- First, **the store is the record**. The scheme this replaced kept tasks as
-- files in each repository, so git was the history: what was finished, and when.
-- There is no git here, so this database holds the only copy of who was carrying
-- what — which is why it is `BackedUp` and not, as the app's own read-only
-- sibling memview can be, `LossAccepted`.
--
-- Second, **a Claude session is a client of this**. The prompt hook on the Mac
-- reads its index on every prompt over the VPN, so the app has to be reachable
-- from there and has to be quick; and `AGENT_TOKEN` is what admits it. That key
-- is a REQUIRED secret reference rather than an optional one: unset, the agent
-- API closes and every session silently loses its task list, which reads exactly
-- like having no tasks.
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
      , AGENT_TOKEN = "AGENT_TOKEN"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let lit = T.EnvValue.Literal

in  T.namespaceOf
      (     { name = "tasks"
      , placement = T.on T.Cluster.isis
      , db = Some
        { dbName = "tasks"
        , innodbBufferPoolGi = None Natural
        , -- Rows of one-line subjects and short markdown bodies, plus one event
          -- row per change. The corpus this replaces was 21 tasks and 21 body
          -- files; 5 Gi is the smallest unit the fleet asks for and is already
          -- absurd headroom.
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
        { -- The hostname resolves to the WireGuard address, not the public one.
          -- Obscurity, NOT a firewall — the isis ingress answers on the public IP
          -- too, and the Nextcloud login plus the `pippijn`-only allow-list is the
          -- real gate. But it does mean HTTP-01 cannot validate, hence a DNS-01
          -- certificate, which is what this arm decides.
          reach =
            T.Reach.Ingress { host = dns.tasks, exposure = T.Exposure.VpnOnly }
        , name = "tasks"
        , image = T.Image.Fleet "tasks"
        , command = None (List Text)
        , port = 8092
        , -- Matches the nonroot user baked into the image (Dockerfile).
          uid = 65532
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- Everything it writes goes to the database.
          rootFs = T.RootFs.ReadOnly
        , env =
          [ { -- Full mysql:// DSN (carries the DB password) — kept whole.
              name = "DATABASE_URL"
            , value = secret keys.DATABASE_URL
            }
          , { name = "SESSION_SECRET", value = secret keys.SESSION_SECRET }
          , { name = "NC_BASE_URL", value = lit "https://${dns.dash}" }
          , { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
          , { -- Where the *pod* reaches Nextcloud. Not the public name: dash
              -- resolves to this node's own public IP, and a pod cannot open a
              -- connection to it — the packet hairpins and is refused. The app
              -- sends the public host as a `Host:` header over this address so
              -- Nextcloud's trusted-domain routing is unchanged.
              name = "NC_INTERNAL_URL"
            , value = lit "http://nextcloud-server.nextcloud.svc.cluster.local"
            }
          , { -- Derived from the same hostname the Ingress serves, so the OAuth
              -- callback cannot drift from where the app actually lives.
              name = "NC_REDIRECT_URI"
            , value = lit "https://${dns.tasks}/auth/callback"
            }
          , { -- One person. An empty list is rejected by the app rather than
              -- treated as "everybody", but naming him here means the fleet's
              -- other Nextcloud accounts are never a question.
              name = "ALLOWED_USERS"
            , value = lit "pippijn"
            }
          , { -- What a Claude session presents. ⚠ Required, not optional: unset,
              -- the agent API closes and every session's task list goes silent
              -- while the app looks perfectly healthy.
              --
              -- It authenticates the MACHINE, not the conversation — every
              -- session on the Mac holds the same value — which is written up in
              -- the app's `config.rs` and must not be forgotten here.
              name = "AGENT_TOKEN"
            , value = secret keys.AGENT_TOKEN
            }
          , { -- info = one line per /api request (TraceLayer) plus the client
              -- activity trace; tasks=debug adds our own low-volume detail.
              -- Third-party crates stay at info (quiet).
              name = "RUST_LOG"
            , value = lit "info,tasks=debug"
            }
          ]
        , readiness = None T.Readiness
        , probeTiming = T.standardTiming
        , probe = T.Probe.Http { path = "/healthz", port = 8092 }
        , resources =
          { requests = { cpu = "25m", memory = "64Mi" }
          , -- The heavy read is a list of a few hundred one-line rows; the
            -- bodies are fetched one at a time. Nothing here is resident.
            limits =
            Some { cpu = Some "500m", memory = "256Mi" }
          }
        , volumes = [] : List T.Volume
        , mounts = [] : List T.VolumeMount
        , tasks = [] : List T.ScheduledTask
        }
      , secrets = toMap keys
      , netpol = T.Netpol.IngressFromNginx
      }
          : T.App
      )
