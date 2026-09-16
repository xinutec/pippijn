let T =
      -- recall's fleet tier: the browsing API, the web app and the sync ingest,
      -- in ONE container running `recalld`. NO ML runs here — the Mac keeps
      -- capture/ASR/diarize/LLM — so this is a light Rust + SQLite + static
      -- frontend over the archive on its own volume.
      --
      -- ⚠ THE SECRET KEYS ARE THE WHOLE RISK IN THIS FILE (count them in `keys`
      -- below, not here — a number in prose rots), and most are
      -- OPTIONAL, which is the dangerous kind. A missing required key crash-loops the
      -- pod and somebody notices within a minute. A missing optional one starts
      -- cleanly and leaves the web UI with NO LOGIN — the archive is transcripts of
      -- conversations in this house, so that failure is silent and serious.
      --
      -- Modelled LAST of the twelve for that reason.
      ../lib/types.dhall

let dataPath = "/data"

let port = 8000

let ingestPort = 8001

let keys =
      -- The keys as a RECORD, so a typo is a type error rather than a pod that boots
      -- with an empty credential. `secrets = toMap keys` publishes the same
      -- expressions `secret.sh` writes.
      { SYNC_TOKEN = "SYNC_TOKEN"
      , SESSION_SECRET = "SESSION_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      , DEVICE_TOKEN = "DEVICE_TOKEN"
      , -- The fourth credential plane (recall/docs/architecture.md): the
        -- per-source write-only ingest token table recalld reads, one
        -- `<source> <token>` per line. Held as ONE secret value because it is
        -- one table; the per-device split lives in its lines.
        INGEST_TOKENS = "INGEST_TOKENS"
      }

let required = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let optional =
      -- Optional here means "the pod starts without it", and every use below says
      -- what is lost when it is absent. None of them is optional for convenience.
      λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = True }

let lit = T.EnvValue.Literal

in  T.namespaceOf
      (     { name = "recall"
      , placement = T.on T.Cluster.isis
      , db = None T.Database
      , storage = Some
        { -- The SQLite system-of-record and the audio segments together. Audio
          -- is what makes it 50 Gi rather than a gigabyte.
          storageGi = 50
        , mountPath = dataPath
        , -- The mount is the volume ROOT: `recalld --root /data` binds the
          -- archive to it, and a subPath would point the app at an empty child
          -- that it would happily populate as a second, invisible archive.
          subPath = None Text
        , -- One RWO PVC holding a SQLite database. Two pods writing it is
          -- corruption, not a race — and the hostPort would forbid a rolling
          -- update anyway, since the second pod could not bind 8000.
          writers = T.Writers.Exclusive
        , -- The one modelled volume in the fleet that is a PRIMARY copy. odin's
          -- restic backs it up (a consistent `sqlite .backup` plus the audio);
          -- dev-lint checks that claim against the reconciler's backup table, so
          -- stating it here without the row failing is not possible.
          durability = T.Durability.BackedUp
        , chown = T.FsGroupChange.Always
        }
      , -- Configured entirely from the environment; no files to mount.
        configMap = None T.ConfigMapDoc
      , workload =
        T.Workload::{ -- No Ingress and no DNS record. The shared nginx ingress answers on
          -- isis's PUBLIC address whatever DNS says — obscurity, not a gate —
          -- and this archive is transcripts of
          -- conversations in the house. The hostPort pinned to the tunnel address
          -- IS the gate.
          reach = T.Reach.WireGuard { alsoPublish = [ ingestPort ] }
        , name = "recall"
        , image = T.Image.Fleet "recall"
        , -- recalld, the Rust system-of-record daemon, and the only container.
          -- It binds both doors itself.
          --
          -- ⚠ **NO `--upstream`, and that needed a CODE change first.** Without
          -- one, recalld's fallback is the SPA, so `/sync/anything-unmatched`
          -- would answer index.html with a 200, which is how the Mac's sync and
          -- jobs agents die. recalld makes an unmatched path under `/api/` or
          -- `/sync/` a 404 instead. Do not restore this flag without restoring
          -- that reasoning.
          command = Some
          [ "recalld"
          , "--root"
          , dataPath
          , -- BOTH: the port the browser and the registered OAuth redirect
            -- already use, and the ingest port recorders already push to.
            "--bind"
          , "0.0.0.0:${Natural/show port}"
          , "--bind"
          , "0.0.0.0:${Natural/show ingestPort}"
          , -- ⚠ Safe only BECAUSE the fallback knows `/sync/*` is not a UI
            -- route. See the command note above.
            "--frontend"
          , "/app/frontend/dist/recall-web/browser"
          ]
        , -- The browser's door and the registered OAuth redirect. `alsoPublish`
          -- above carries `ingestPort` beside it, from this same container.
          --
          -- ⚠ The container that DECLARES a port need not be the one that binds
          -- it: the declaration installs the CNI portmap DNAT into the POD's
          -- namespace, and any container in it may answer. Here they are the
          -- same container, and that is worth keeping true.
          port
        , uid = 1000
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- Everything it writes is a mount: the archive, /tmp (ffmpeg scratch)
          -- and /app/logs.
          rootFs = T.RootFs.ReadOnly
        , -- ⚠ **RECALL_ROLE IS GONE, and its absence is the point.** It told the
          -- Python tier it was the fleet rather than a capture node. Nothing in
          -- recalld reads it (`grep RECALL_ROLE recalld/src` is empty), and a
          -- variable no process reads is a claim nobody checks.
          env =
          [ { -- The read side (listing, blobs, the work queue) is the Mac's
              -- plane, so it presents the same sync token it already holds.
              name = "RECALLD_READ_TOKEN"
            , value = required keys.SYNC_TOKEN
            }
          , { -- ⚠ THE SAME SECRET AS ABOVE, AND A DIFFERENT GATE. This one
              -- decides whether recalld MOUNTS the `/sync/*` routes at all.
              --
              -- ⚠ Removing it is NO LONGER A ROLLBACK. While the Python tier
              -- existed, unmounting these routes let the Mac's requests fall
              -- through the proxy to it. There is no proxy and no upstream now,
              -- so absent means the Mac's sync gets 404 — the rollback is the
              -- previous image, not this line.
              name = "RECALL_SYNC_TOKEN"
            , value = required keys.SYNC_TOKEN
            }
          , { -- Optional means the pod starts without it — and what is lost is
              -- the WRITE gate: an absent table leaves ingest open to anything
              -- on the tunnel. Appends are not the fleet's threat (destruction
              -- is; the plane has no delete), but set the key at deploy rather
              -- than leaving this open.
              name = "RECALLD_INGEST_TOKENS"
            , value = optional keys.INGEST_TOKENS
            }
          , { -- ⚠ Without these recalld serves NONE of its browsing routes.
              -- `webauth = None` means ABSENT, not open — these routes serve
              -- household transcripts, so an unconfigured recalld answers them
              -- 404 rather than answering them to anyone — and recalld is the
              -- whole UI, so that is the site gone rather than a degraded one.
              name = "RECALL_SESSION_SECRET"
            , value = optional keys.SESSION_SECRET
            }
          , { name = "NC_CLIENT_ID", value = optional keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET"
            , value = optional keys.NC_CLIENT_SECRET
            }
          , { name = "RECALL_ALLOWED_USERS", value = lit "pippijn" }
          , { -- The Android meeting recorder's upload credential. A phone cannot
              -- do the OAuth login — the WebView that can is a SEPARATE app with
              -- its own cookie jar — so without this every `POST /api/sessions`
              -- from the recorder is a 401. Accepted on that one route and no
              -- other, so it does
              -- not become a reader of the transcripts. Deliberately NOT
              -- SYNC_TOKEN: a phone is easier to lose than the Mac, and that key
              -- opens all of /sync/*.
              name = "RECALL_DEVICE_TOKEN"
            , value = optional keys.DEVICE_TOKEN
            }
          , { -- ⚠ SET rather than defaulted. recalld falls back to this exact
              -- string in `webauth.rs`, so omitting it would work today by
              -- coincidence — and this URL is registered in Nextcloud's OAuth2
              -- client and must match character for character. A coincidence is
              -- not a place to keep a registered value.
              name = "NC_REDIRECT_URI"
            , value = lit "http://10.100.0.2:${Natural/show port}/auth/callback"
            }
          , { -- The token exchange goes pod → Nextcloud directly, staying inside
              -- the cluster rather than back out over the tunnel. This is what
              -- the netpol's nextcloud egress rule below permits, and the two
              -- must stay in step. recalld's ureq is built without TLS, so the
              -- plain-http in-cluster address is not optional for it.
              name = "NC_INTERNAL_URL"
            , value = lit "http://nextcloud-server.nextcloud.svc.cluster.local"
            }
          ]
        , probeTiming =
            -- Its own, like the other two tunnel-only apps: reached by a
            -- hostPort it cannot roll, so readiness delay is downtime per
            -- deploy.
            { readiness = { initialDelaySeconds = 3, periodSeconds = 10 }
            , liveness = Some { initialDelaySeconds = 10, periodSeconds = 30 }
            }
        , -- ⚠ **`ingestPort`, and that is not arbitrary.** recalld binds every
          -- port before serving any, so 8001 answering proves 8000 is bound too
          -- — one probe covers both doors.
          --
          -- `/ingest/v1/health` because it needs no session: probing a browsing
          -- route would exercise the SSO middleware, and an expired secret would
          -- then read as a dead pod. The old two-container arrangement probed
          -- `/api/capture` on the Python's own port for the same reason, and that
          -- reasoning moves here with the container.
          probe = T.Probe.Http { path = "/ingest/v1/health", port = ingestPort }
        , resources =  Some
          { requests = { cpu = "100m", memory = "256Mi" }
          , limits = Some { cpu = Some "1", memory = "1Gi" }
          }
        , volumes =
          [ { name = "tmp", source = T.VolumeSource.EmptyDir }
          , { name = "logs", source = T.VolumeSource.EmptyDir }
          ]
        , mounts =
          [ { name = "tmp"
            , mountPath = "/tmp"
            , subPath = None Text
            , -- ffmpeg scratch. Writable, which is the point: the root
              -- filesystem is read-only and this is where the writes go.
              readOnly = False
            }
          , { name = "logs"
            , mountPath = "/app/logs"
            , subPath = None Text
            , -- Log rotation and the client-error log.
              readOnly = False
            }
          ]
        }
      , secrets = toMap keys
      , -- Default-deny egress with exactly one exception besides DNS: the SSO
        -- token exchange with Nextcloud, in-cluster on port 80. Egress-only
        -- because k3s enforces through kube-router, which does not exempt
        -- node-sourced kubelet probes — a default-deny INGRESS would drop them
        -- and take the pod NotReady.
        netpol =
          T.Netpol.Egress
            [ { namespace = "kube-system"
              , ports =
                [ { port = 53, protocol = "UDP" }
                , { port = 53, protocol = "TCP" }
                ]
              }
            , { namespace = "nextcloud"
              , ports = [ { port = 80, protocol = "TCP" } ]
              }
            ]
      }
          : T.App
      )
