-- recall's fleet tier: api + web + the sync ingest, one container. NO ML runs
-- here — the Mac keeps capture/ASR/diarize/LLM — so this is a light FastAPI +
-- SQLite + static frontend over the archive on its own volume.
--
-- ⚠ THE FIVE SECRET KEYS ARE THE WHOLE RISK IN THIS FILE, and four of them are
-- OPTIONAL, which is the dangerous kind. A missing required key crash-loops the
-- pod and somebody notices within a minute. A missing optional one starts
-- cleanly and leaves the web UI with NO LOGIN — the archive is transcripts of
-- conversations in this house, so that failure is silent and serious. This model
-- was checked field-by-field against the live Deployment on isis before it was
-- rendered (2026-08-12: nine env vars, in this order, four carrying
-- `optional: true`, and all five keys present in `recall-secret`), not against
-- the committed manifest alone.
--
-- Modelled LAST of the twelve for that reason.
let T = ../lib/types.dhall

let dataPath = "/data"

let port = 8000

let keys =
      { SYNC_TOKEN = "SYNC_TOKEN"
      , SESSION_SECRET = "SESSION_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      , DEVICE_TOKEN = "DEVICE_TOKEN"
      }

let required = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let optional = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = True }

let lit = T.EnvValue.Literal

in    { name = "recall"
      , cluster = T.Cluster.isis
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
        }
      , -- Configured entirely from the environment; no files to mount.
        configMap = None T.ConfigMapDoc
      , workload =
        { -- No Ingress and no DNS record. The shared nginx ingress answers on
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
          , "${Natural/show port}"
          ]
        , port
        , uid = 1000
        , -- Everything it writes is a mount: the archive, /tmp (ffmpeg scratch)
          -- and /app/logs.
          readOnlyRootFs = True
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
            , liveness = { initialDelaySeconds = 10, periodSeconds = 30 }
            }
        , -- `Tcp`, not `Http`: it is honest about what is actually checked.
          -- There is no health endpoint, and probing `/` would exercise the
          -- session middleware on every tick.
          probe = T.Probe.Tcp { port }
        , resources =
          { requests = { cpu = "100m", memory = "256Mi" }
          , limits = { cpu = "1", memory = "1Gi" }
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
      , tasks = [] : List T.ScheduledTask
      }
    : T.App
