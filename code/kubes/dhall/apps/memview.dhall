let T =
      -- memview.xinutec.org — a read-only viewer for the Claude memory corpus
      -- (Rust axum + Angular). Repo: github.com/xinutec/memview.
      --
      -- ⚠ The corpus is the most personal data the fleet holds. Two consequences:
      --
      --   * the image carries only the VIEWER — the memories arrive as a volume the
      --     Mac pushes up, which is why the repo can be public;
      --   * the auth keys below are REQUIRED rather than optional secret references.
      --     memview serves everything it can read to whoever gets past the gate, so a
      --     pod that fails to start beats a pod that starts unguarded.
      ../lib/types.dhall

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
        , -- The safe default. The pod only reads this volume, so `Concurrent`
          -- would also be true; `Recreate` costs a few seconds per deploy.
          writers = T.Writers.Exclusive
        , -- Nothing here is a primary copy. The corpus is pushed wholesale from
          -- the Mac by every sync, so a restore re-syncs it, and the `state`
          -- subPath holds only mined artefacts the same sync pushes. Backing
          -- this up would duplicate the Mac's own backup of the same bytes.
          durability =
            T.Durability.LossAccepted
              { why =
                  "memview holds no primary copy: the corpus and the mined artefacts in the state subPath are re-pushed wholesale by every sync from the Mac"
              }
        , chown = T.FsGroupChange.Always
        }
      , -- Configured entirely from the environment; no files to mount.
        configMap = None T.ConfigMapDoc
      , workload =
        T.Workload::{ name = "memview"
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
        , port = 8091
        , -- Matches the nonroot user baked into the image (Dockerfile).
          uid = 65532
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- It writes nothing, anywhere.
          rootFs = T.RootFs.ReadOnly
        , env =
          [ { name = "MEMORY_DIR", value = lit corpusPath }
          , { -- How much each memory is actually used, mined from the session
              -- transcripts on the Mac and pushed by scripts/sync.sh. Optional:
              -- absent, the graph still draws, sized by links alone. On the
              -- state subPath rather than in the corpus, which every sync
              -- replaces wholesale.
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
              -- ⚠ It carries COMMAND TEXT. Pippijn's call: "Isis should be
              -- trusted. Everything can go there." Owner-only at /api/effects,
              -- never behind a share token, and the largest thing the sync
              -- pushes.
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
          , { -- One person. An empty list is rejected by the app rather than
              -- treated as "everybody", but naming him here means the fleet's
              -- other Nextcloud accounts are never a question.
              name = "ALLOWED_USERS"
            , value = lit "pippijn"
            }
          , { name = "RUST_LOG", value = lit "info,memview=debug" }
          ]
        , probeTiming = T.standardTiming
        , probe = T.Probe.Http { path = "/healthz", port = 8091 }
        , resources =  Some
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
        }
      , secrets = toMap keys
      , netpol = T.Netpol.IngressFromNginx
      }
          : T.App
      )
