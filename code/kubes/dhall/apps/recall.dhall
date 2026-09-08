let T =
      -- recall's fleet tier: api + web + the sync ingest, one container. NO ML runs
      -- here — the Mac keeps capture/ASR/diarize/LLM — so this is a light FastAPI +
      -- SQLite + static frontend over the archive on its own volume.
      --
      -- ⚠ THE SECRET KEYS ARE THE WHOLE RISK IN THIS FILE (count them in `keys`
      -- below, not here — a number in prose rots), and most are
      -- OPTIONAL, which is the dangerous kind. A missing required key crash-loops the
      -- pod and somebody notices within a minute. A missing optional one starts
      -- cleanly and leaves the web UI with NO LOGIN — the archive is transcripts of
      -- conversations in this house, so that failure is silent and serious. This model
      -- was checked field-by-field against the live Deployment on isis before it was
      -- rendered (2026-08-12: nine env vars, in this order, four carrying
      -- `optional: true`, and every then-current key present in `recall-secret`),
      -- not against the committed manifest alone.
      --
      -- Modelled LAST of the twelve for that reason.
      ../lib/types.dhall

let dataPath = "/data"

let port = 8000

let ingestPort = 8001

let -- ⚠ POD-INTERNAL ONLY, and that is the whole cutover. recalld became the
    -- front door on 2026-09-07: it binds BOTH 8000 (what the browser and the
    -- registered OAuth redirect already use) and 8001 (what recorders already
    -- push to), and forwards whatever it has not ported yet to the Python here.
    -- The hostPort DNATs into the pod's shared network namespace, so WHICH
    -- container binds 8000 is not something Kubernetes polices — which is why
    -- nothing external moves: no recorder reconfigured, no redirect
    -- re-registered, no bookmark changed.
    apiPort = 8002

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
        , -- The mount is the volume ROOT: `recall api --out /data` binds the
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
          -- isis's PUBLIC address whatever DNS says — obscurity, not a gate,
          -- confirmed 2026-07-09 — and this archive is transcripts of
          -- conversations in the house. The hostPort pinned to the tunnel address
          -- IS the gate.
          reach = T.Reach.WireGuard
        , name = "recall"
        , image = T.Image.Fleet "recall"
        , -- ⚠ `--out` is what binds the archive to /data. `recall api`
          -- OVERWRITES RECALL_OUT from this flag, so setting the env var
          -- instead would be ignored — the flag is the only thing that works.
          command = Some
          [ "python"
          , "-m"
          , "recall"
          , "api"
          , "--out"
          , dataPath
          , "--host"
          , "0.0.0.0"
          , "--port"
          , "${Natural/show apiPort}"
          ]
        , -- ⚠ DECLARED here, but SERVED by the recalld sidecar since 2026-09-07.
          -- The declaration is what installs the CNI portmap DNAT from the
          -- tunnel address to the POD's 8000, and the containers share one
          -- network namespace — so the mapping is the pod's, not this
          -- container's, and recalld is what answers on it. This container now
          -- listens on `apiPort` behind recalld's proxy.
          --
          -- It stays here because `Sidecar.port` holds ONE port and recalld
          -- needs 8001 for the recorders. Moving it would need the model to take
          -- a list per container, which is a bigger change than this cutover.
          port
        , uid = 1000
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- Everything it writes is a mount: the archive, /tmp (ffmpeg scratch)
          -- and /app/logs.
          rootFs = T.RootFs.ReadOnly
        , env =
          [ { -- This node is the system of record, not a capture node:
              -- /api/capture records pause/resume as INTENT that the Mac
              -- mirrors onto the real mic. RECALL_SYNC_TOKEN cannot signal
              -- this, because the Mac sets that too, so the role is explicit.
              name = "RECALL_ROLE"
            , value = lit "fleet"
            }
          , { -- REQUIRED, unlike the four below: the sync routes only exist
              -- when it is set, so an absent one is a fleet tier that quietly
              -- accepts nothing from the Mac.
              name = "RECALL_SYNC_TOKEN"
            , value = required keys.SYNC_TOKEN
            }
          , { -- Optional: absent, the web UI has no session signing key and
              -- therefore no login. The archive still serves the Mac over the
              -- sync token, which is why this fails quiet rather than
              -- crash-looping.
              name = "RECALL_SESSION_SECRET"
            , value = optional keys.SESSION_SECRET
            }
          , { name = "NC_CLIENT_ID", value = optional keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET"
            , value = optional keys.NC_CLIENT_SECRET
            }
          , { name = "RECALL_ALLOWED_USERS", value = lit "pippijn" }
          , { -- The Android meeting recorder's upload credential. A phone
              -- cannot do the OAuth login above — the WebView that can is a
              -- separate app with its own cookie jar — so without this every
              -- `POST /api/sessions` from the app is a 401, which is exactly
              -- what happened until 2026-08-07. Accepted on that one route and
              -- no other, so it does not become a reader of the transcripts.
              -- Deliberately NOT SYNC_TOKEN: a phone is easier to lose than the
              -- Mac, and that key opens all of /sync/*.
              name = "RECALL_DEVICE_TOKEN"
            , value = optional keys.DEVICE_TOKEN
            }
          , { -- The browser is on the far side of the tunnel, so the callback
              -- has to be an address it can actually reach — `T.wgAddress`
              -- would be the derived form, but this URL is registered in
              -- Nextcloud's OAuth2 client and must match it character for
              -- character, so it is written out.
              name = "NC_REDIRECT_URI"
            , value = lit "http://10.100.0.2:${Natural/show port}/auth/callback"
            }
          , { -- The token exchange goes pod → Nextcloud directly, staying
              -- inside the cluster rather than back out over the tunnel. This
              -- is what the netpol's nextcloud egress rule below permits, and
              -- the two must stay in step.
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
        , -- ⚠ This container's probe must test THIS container, and since
          -- 2026-09-07 that means `apiPort`, not `port`. recalld binds `port`
          -- now, so a check there would pass whenever RECALLD is up — including
          -- with this one dead and every unported route 502ing behind the proxy.
          -- Kubernetes would call the pod healthy while most of the app was
          -- broken.
          --
          -- `/api/capture` because it is the one Python route that needs no
          -- session (webauth's exempt set: the phones poll it login-free), so
          -- probing it exercises no session middleware — the property the old
          -- `Tcp` probe was chosen for, now with an actual answer behind it.
          --
          -- recalld is covered by the sidecar's OWN probe below. Each container
          -- probes ITSELF: an earlier draft had this one testing Python THROUGH
          -- the proxy, which silently stops testing Python the moment recalld
          -- ports the probed route. And recalld binds every port before serving
          -- any, so its 8001 answering proves 8000 is bound too.
          probe = T.Probe.Http { path = "/api/capture", port = apiPort }
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
        , sidecars =
          [ T.Sidecar::{
            , -- recalld, the Rust system-of-record daemon (recall/docs/
              -- architecture.md, stage A): the store-and-forward ingest plane.
              -- Same image as the api container — the Dockerfile builds the
              -- binary into it — so one push rolls both tiers together.
              name = "recalld"
            , command =
              [ "recalld"
              , "--root"
              , "/data"
              , -- BOTH: the ingest port recorders already push to, and the port
                -- the browser and the OAuth redirect already use.
                "--bind"
              , "0.0.0.0:${Natural/show ingestPort}"
              , "--bind"
              , "0.0.0.0:${Natural/show port}"
              , -- Whatever recalld has not ported yet, over loopback inside this
                -- pod. A FALLBACK, never an override: a ported route always wins.
                "--upstream"
              , "http://127.0.0.1:${Natural/show apiPort}"
              , -- The built Angular app. ⚠ Restored 2026-09-07 only AFTER the
                -- fallback learned that /sync/* belongs to the upstream. With a
                -- frontend mounted, anything not matched and not under an
                -- upstream prefix is answered with the app SHELL — and /sync/*
                -- fell into that gap, so the Mac's sync and jobs agents received
                -- index.html with a 200 and died parsing it. Dropping this flag
                -- was the mitigation, because with no frontend every unmatched
                -- path proxies instead.
                "--frontend"
              , "/app/frontend/dist/recall-web/browser"
              ]
            , -- Its own wg-pinned hostPort beside the api's 8000: recorders
              -- deliver segments here from anywhere on the tunnel.
              port = Some ingestPort
            , probe = T.Probe.Http
                { path = "/ingest/v1/health", port = ingestPort }
            , -- The same PVC: the ingest tree lands under /data/ingest, inside
              -- what odin's nightly restic already rsyncs.
              shareMounts = True
            , env =
              [ { -- The read side (listing, blobs, later the work queue) is
                  -- the Mac's plane, so it presents the same sync token it
                  -- already holds.
                  name = "RECALLD_READ_TOKEN"
                , value = required keys.SYNC_TOKEN
                }
              , { -- ⚠ THE SAME SECRET AS ABOVE, AND A DIFFERENT GATE. This one
                  -- does not open or close anything: it decides whether recalld
                  -- MOUNTS the `/sync/*` routes at all. Absent, they are not
                  -- mounted and the Mac's requests fall through the proxy to the
                  -- api container, exactly as before recalld had them.
                  --
                  -- So this line IS the cutover, and removing it is the
                  -- rollback — no image build either way, which matters because
                  -- fleet images are `:latest` only and a rollback would
                  -- otherwise be a roll-forward.
                  --
                  -- It reads the same `SYNC_TOKEN` key the api reads, so the two
                  -- halves agree by construction rather than by remembering.
                  -- Named separately from RECALLD_READ_TOKEN because they are
                  -- two planes that happen to share one secret today.
                  name = "RECALL_SYNC_TOKEN"
                , value = required keys.SYNC_TOKEN
                }
              , { -- Optional means the pod starts without it — and what is
                  -- lost is the WRITE gate: an absent table leaves ingest
                  -- open to anything on the tunnel. Appends are not the
                  -- fleet's threat (destruction is; the plane has no delete),
                  -- but set the key at deploy rather than leaving this open.
                  name = "RECALLD_INGEST_TOKENS"
                , value = optional keys.INGEST_TOKENS
                }
              , { -- ⚠ THE SAME SSO KEYS THE API HOLDS, and without them recalld
                  -- serves NONE of its ported browsing routes. `webauth = None`
                  -- means ABSENT there, not open — these routes serve household
                  -- transcripts, so an unconfigured recalld answers them 404
                  -- rather than answering them to anyone. Deploying the cutover
                  -- without these left every ported route falling through to the
                  -- proxy: the app worked, and none of the Rust was reached.
                  --
                  -- ⚠ The session secret must be the SAME VALUE as the api's.
                  -- The token format is byte-identical on purpose, so one cookie
                  -- verifies in both halves and a route group can move between
                  -- them with nobody signing in again. Two different secrets and
                  -- every proxied route 401s while the ported ones work.
                  name = "RECALL_SESSION_SECRET"
                , value = optional keys.SESSION_SECRET
                }
              , { name = "NC_CLIENT_ID", value = optional keys.NC_CLIENT_ID }
              , { name = "NC_CLIENT_SECRET"
                , value = optional keys.NC_CLIENT_SECRET
                }
              , { name = "RECALL_ALLOWED_USERS", value = lit "pippijn" }
              , { -- Server-to-server OAuth goes over plain HTTP in-cluster,
                  -- presenting the public host so Nextcloud's trusted-domain
                  -- routing treats it like the public request. recalld's ureq is
                  -- built without TLS, so this is not optional for it.
                  name = "NC_INTERNAL_URL"
                , value =
                    lit "http://nextcloud-server.nextcloud.svc.cluster.local"
                }
              , { -- The meeting recorder's upload credential, on the same terms
                  -- as the api's: one route, not a reader of transcripts.
                  name = "RECALL_DEVICE_TOKEN"
                , value = optional keys.DEVICE_TOKEN
                }
              ]
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
