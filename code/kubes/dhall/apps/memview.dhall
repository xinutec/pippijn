-- memview.xinutec.org — a read-only viewer for the Claude memory corpus
-- (Rust axum + Angular). Repo: github.com/xinutec/memview.
--
-- The corpus is the most personal data the fleet holds: medical context, family,
-- addresses, private feedback. Two consequences run through this whole file.
--
-- First, the app never *contains* the corpus — the published image carries only
-- the viewer, and the memories arrive as a volume the Mac pushes up. That is why
-- the repo can be public and the image can be pulled from Docker Hub.
--
-- Second, the sign-in gate is not optional here. `memview` serves everything it
-- can read to whoever gets past it, so the three auth keys below are required
-- secret references rather than optional ones: a pod that fails to start is
-- much better than a pod that starts unguarded.
let T = ../lib/types.dhall

let dns = ../dns.dhall

let keys =
      { SESSION_SECRET = "SESSION_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let lit = T.EnvValue.Literal

let corpusPath = "/corpus"

let statePath = "/state"

in  T.namespaceOf
      (     { name = "memview"
      , placement = T.on T.Cluster.isis
      , db = None T.Database
      , storage = Some
        { -- The corpus is ~280 small markdown files, well under a megabyte, and
          -- grows by a few files a week. 1 Gi is already absurd headroom; the
          -- local-path provisioner has no smaller unit worth asking for.
          storageGi = 1
        , mountPath = corpusPath
        , subPath = Some "corpus"
        , -- `ShareStore` holds the whole share document in memory and rewrites
          -- it whole on every read of a shared page. A second pod's copy —
          -- loaded before the first created a share — would erase it on the
          -- next touch. Atomic writes (#744) stop a reader seeing half a file
          -- and do nothing whatever about that, so this is `Recreate`.
          writers = T.Writers.Exclusive
        , -- Nothing here is a primary copy. The corpus is pushed wholesale from
          -- the Mac by every sync, so a restore re-syncs it; the `state`
          -- subPath holds only the share-token file, and a lost token is
          -- re-issued rather than recovered. Backing this up would duplicate
          -- the Mac's own backup of the same bytes.
          durability =
            T.Durability.LossAccepted
              { why =
                  "memview holds no primary copy: the corpus is re-pushed wholesale by every sync from the Mac, and the state subPath holds only a re-issuable share token"
              }
        , chown = T.FsGroupChange.Always
        }
      , -- Configured entirely from the environment; no files to mount.
        configMap = None T.ConfigMapDoc
      , workload =
        { name = "memview"
        , -- The hostname resolves to the WireGuard address, not the public one, so
          -- the corpus is not advertised to the internet at large. Obscurity, not
          -- a firewall — the ingress still answers on the public IP — but it does
          -- mean HTTP-01 cannot validate, hence a DNS-01 certificate.
          --
          -- ⚠ `Ingress`, not `WireGuard`: there IS an Ingress here. The stronger
          -- arm is a hostPort DNAT'd to the tunnel address with no ingress at all,
          -- which scanner, recall and observe use.
          reach =
            T.Reach.Ingress
              { host = dns.memview, exposure = T.Exposure.VpnOnly }
        , image = T.Image.Fleet "memview"
        , command = None (List Text)
        , port = 8091
        , -- Matches the nonroot user baked into the image (Dockerfile).
          uid = 65532
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- The only thing it writes is the share-token state file, which lives
          -- on the volume below, so the root filesystem stays read-only.
          rootFs = T.RootFs.ReadOnly
        , env =
          [ { name = "MEMORY_DIR", value = lit corpusPath }
          , { -- The one public share token, persisted so it survives a restart.
              -- On the same volume as the corpus but a different subPath: the
              -- corpus is replaced wholesale by every sync, and a token living
              -- inside it would be deleted by one.
              name = "SHARE_STATE"
            , value = lit "${statePath}/share-state.json"
            }
          , { -- How much each memory is actually used, mined from the session
              -- transcripts on the Mac and pushed by scripts/sync.sh. Optional:
              -- absent, the graph still draws, sized by links alone. On the
              -- state volume rather than the corpus for the same reason as the
              -- share token — every sync replaces the corpus wholesale.
              name = "COUSE_FILE"
            , value = lit "${statePath}/couse.json"
            }
          , { -- Which named session works in which project directory, mined
              -- from the same transcripts and pushed by the same sync.
              -- Optional in the same way: absent, the agents page says nothing
              -- has been mined rather than failing.
              name = "AGENTS_FILE"
            , value = lit "${statePath}/agents.json"
            }
          , { -- The timeline: what each session did, in order, and how it
              -- turned out. Ten times the roster's size and held in memory
              -- rather than re-read per request, so the pod picks up a new one
              -- on the first request after the sync rather than at once.
              name = "DOING_FILE"
            , value = lit "${statePath}/doing.json"
            }
          , { -- What each turn did to which file, with the command that did it
              -- — the evidence a reader wants standing on a timeline row.
              -- Optional in the same way: absent, a turn opens to nothing
              -- rather than erroring.
              --
              -- ⚠ The first artefact carrying COMMAND TEXT. Pippijn settled
              -- that on 2026-08-13 ("Isis should be trusted. Everything can go
              -- there."). It is owner-only at /api/effects, never behind a
              -- share token, and 35 MB — the largest thing the sync pushes.
              name = "EFFECTS_FILE"
            , value = lit "${statePath}/effects.json"
            }
          , { -- All three of these must be set or the app serves the corpus to
              -- anyone who can reach it. Required references, not optional ones:
              -- a pod that will not start is the safe failure here.
              name = "SESSION_SECRET"
            , value = secret keys.SESSION_SECRET
            }
          , { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
          , { name = "NC_BASE_URL", value = lit "https://${dns.dash}" }
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
            , value = lit "https://${dns.memview}/auth/callback"
            }
          , { name = "PUBLIC_BASE_URL", value = lit "https://${dns.memview}" }
          , { -- One person. An empty list is rejected by the app rather than
              -- treated as "everybody", but naming him here means the fleet's
              -- other Nextcloud accounts are never a question.
              name = "ALLOWED_USERS"
            , value = lit "pippijn"
            }
          , { name = "RUST_LOG", value = lit "info,memview=debug" }
          ]
        , readiness = None T.Readiness
        , probeTiming = T.standardTiming
        , probe = T.Probe.Http { path = "/healthz", port = 8091 }
        , resources =
          { requests = { cpu = "25m", memory = "64Mi" }
          , -- The corpus is re-read from disk on every request — a deliberate
            -- choice, since a live Claude session writes memories and staleness
            -- would be worse than the read cost. That makes it steady small
            -- reads rather than a resident cache, so the ceiling is modest.
            limits =
            Some { cpu = Some "500m", memory = "256Mi" }
          }
        , volumes = [] : List T.Volume
        , mounts =
          [ { name = "app-data"
            , mountPath = statePath
            , subPath = Some "state"
            , readOnly = False
            }
          ]
        , tasks = [] : List T.ScheduledTask
        }
      , secrets = toMap keys
      , netpol = T.Netpol.IngressFromNginx
      }
          : T.App
      )
