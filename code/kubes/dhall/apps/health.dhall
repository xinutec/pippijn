-- health.xinutec.org — the health app (TypeScript/node + a verified Lean core).
--
-- The largest tree in the fleet and the only one with BATCH workloads: six
-- CronJobs and two one-shot Jobs share this image and this environment. They are
-- not modelled here yet (they need `T.ScheduledTask`), which is why two `let`s
-- below are exported-looking rather than inlined — `decodeFlags` and
-- `leanTenants` are the env the crons must agree with, and the live manifests
-- say so in prose today ("kept in step with 08-decode-recent.yaml"). Checked
-- pairwise on 2026-08-12: all ten shared values agree. The `let` is what stops
-- that being luck.
--
-- ⚠⚠ NOT DEPLOYABLE YET, and not for the obvious reason. Rendering this tree
-- emits `netpolDb` — `health-db-from-app-only`, which admits port 3306 from
-- `app: health-auth` and nothing else. SIX CRONJOBS TALK TO THIS DATABASE and
-- carry their own labels, so applying the rendered tree today cuts every batch
-- workload off from its data, at 04:00, where nobody is looking. That policy is
-- correct for a namespace holding one workload and false about this one — the
-- same conflation of "a namespace" with "a workload" that `signal` runs into
-- from the other direction. So `T.ScheduledTask` is not the next increment
-- after this file; it is part of the same one.
--
-- ⚠ `readOnlyRootFs = True` is a CHANGE to the live Deployment, and it is
-- measured rather than assumed: the running container's overlay upper layer
-- after 33h held six entries, every one a kubelet bind-mount (`/etc/resolv.conf`,
-- the serviceaccount dir). The app wrote nothing. That measurement is what
-- retires this tree's nine `allow-rootfs-rw` waivers, which stopped being inert
-- on 2026-08-12 when dev-lint's `image_profile` dropped its `health-sync`
-- exemption — the linter had been excusing an image the fleet builds.
let T = ../lib/types.dhall

let dns = ../dns.dhall

let port = 3000

let keys =
      { DB_USER = "DB_USER"
      , DB_PASSWORD = "DB_PASSWORD"
      , DB_ROOT_PASSWORD = "DB_ROOT_PASSWORD"
      , FITBIT_CLIENT_ID = "FITBIT_CLIENT_ID"
      , FITBIT_CLIENT_SECRET = "FITBIT_CLIENT_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      , SESSION_SECRET = "SESSION_SECRET"
      , OWNTRACKS_ALLOWED_TOKENS = "OWNTRACKS_ALLOWED_TOKENS"
      , SERVICE_TOKEN = "SERVICE_TOKEN"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let optionalSecret =
      λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = True }

let lit = T.EnvValue.Literal

-- The Google Health credentials, which live in a secret this model does not
-- manage. See `T.EnvValue.FromUnmanagedSecret`.
let google =
      λ(k : Text) →
        T.EnvValue.FromUnmanagedSecret
          { secret = "health-google", key = k, optional = False }

-- Every batch task reads and writes the same database, so this is their floor
-- rather than something each restates.
let dbEnv
    : List T.EnvVar
    = [ { name = "DB_HOST", value = lit "health-db" }
      , { name = "DB_NAME", value = lit "health" }
      , { name = "DB_USER", value = secret keys.DB_USER }
      , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
      ]

-- Nextcloud OAuth, for the jobs that read places out of it.
let ncEnv
    : List T.EnvVar
    = [ { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
      , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
      ]

-- 30 s, against the request path's 5 s default. A batch job may wait for the
-- verified core; an interactive request may not. This is the flag whose absence
-- from `leanTenants` is deliberate — see the note at LEAN_MATCH.
let leanCallTimeout
    : T.EnvVar
    = { name = "LEAN_CALL_TIMEOUT_MS", value = lit "30000" }

let batchResources
    : T.Resources
    = { requests = { cpu = "100m", memory = "256Mi" }
      , limits = Some { cpu = Some "1000m", memory = "1Gi" }
      }

-- The decode carries more memory than the refreshes: it holds a day's fixes and
-- both arms of every shadowed Lean pass at once.
let decodeResources
    : T.Resources
    = { requests = { cpu = "100m", memory = "256Mi" }
      , limits = Some { cpu = Some "1000m", memory = "1536Mi" }
      }

-- C4 continuity flags (task #224). The auth pod does not READ them — it is the
-- decode that does — but `scripts/prod-db.sh` mirrors the pod env via printenv
-- so a Mac replay decodes the same day the cron wrote. A missing mirror is the
-- exact feedback_parity_tools_must_mirror_env failure, so these are carried
-- here deliberately. Rationale and the open defect (#366) are documented at the
-- cron: kubes/health/k8s/08-decode-recent.yaml.
let decodeFlags
    : List T.EnvVar
    = [ { name = "USE_CADENCE_IMPUTATION", value = lit "1" }
      , { name = "USE_SEGMENT_EVIDENCE", value = lit "1" }
      , { name = "USE_CHAIN_CONTEXT", value = lit "1" }
      , { name = "USE_REACQUIRE_ROBUST_SPEED", value = lit "1" }
      ]

-- The verified-Lean tenants, shared with the decode cron.
--
-- ⚠ SHARED BASE, NOT THE WHOLE ENV. The cron adds `LEAN_HSMM`,
-- `LEAN_STATIONCHAIN` and `LEAN_CALL_TIMEOUT_MS`; the auth pod adds
-- `WALK_BUILDING_ESCAPE`. Only what BOTH must agree on lives here — a list that
-- absorbed the extras would force one of them to carry a flag it does not want.
let leanTenants
    : List T.EnvVar
    = [ { -- Serve the verified Lean geometry passes on the request path
          -- (docs/proposals/2026-07-verified-core-lean.md). `on` routes five
          -- proved display passes — simplify, removeSpurs, trim, despike,
          -- rejectSpikes — through the in-process bridge to verified_cli
          -- (LEAN_CLI is set by the Dockerfile), serving the theorem-backed
          -- output. Golden is 31/31 byte-identical to the pure-TS pipeline
          -- under `on` (the golden corpus measures 2 accepted Douglas-Peucker
          -- near-ties, which wash out downstream; the accepted manifest also
          -- carries entries observed in production on days the corpus does not
          -- cover), and any bridge failure falls back to TS
          -- (swallow-over-wrong). "off"/unset reverts instantly.
          --
          -- DEMOTED on->shadow 2026-08-01. Production output is to come from
          -- the TS implementation while Lean runs alongside as measurement;
          -- this was the last tenant still serving Lean to a reader.
          --
          -- NOTE the request-path cost, which shadow does NOT avoid: `shadow`
          -- runs both arms synchronously through the in-process bridge, so the
          -- Lean arm is added latency on a cache miss either way. Measured over
          -- the 32-day corpus: passes 1.0ms avg / 34ms max per call — free.
          -- The matcher is the one that is not (276ms avg, 4.8s max), and it is
          -- LEAN_MATCH below that pays it, not this flag.
          name = "LEAN_PASSES"
        , value = lit "shadow"
        }
      , { -- Verified Lean walk-matcher (qMatchWalkSegment). ROLLED BACK to
          -- shadow 2026-07-31 after serving `on` since 2026-07-21.
          --
          -- The flip rested on "compare-match 185/185 bit-exact against the
          -- BigInt twin". That number is real (191/191 today) but it measures
          -- quant<->Lean — that serving Lean equals serving the twin. It says
          -- nothing about float<->quant, i.e. how the twin differs from the TS
          -- matcher production served before, and THAT is the set of legs whose
          -- behaviour the flip changes. Those legs were never all signed off.
          --
          -- Measured on leg 71e5544efa614a06 (2026-07-30 09:40Z, King's Cross,
          -- #398): the arms take different corridors for ~2 min, 120 m apart at
          -- coarse vertex 13. The quant line sits 42.1 m from the GPS track at
          -- p85, past matchImprovesDisplay's 40 m cap, so the gate returns
          -- use=false and the leg falls back to RAW GPS — where the float arm
          -- returned use=true and drew a matched line better on every measure
          -- (off-network 3.5 vs 10.9 m, stray 16.5 vs 42.1 m, building
          -- intrusion 169 vs 202 m). A coarse divergence is not display-only:
          -- coarsePath feeds a keep/discard decision (#369).
          --
          -- RE-PROMOTED shadow->on 2026-08-11, against the condition this block
          -- set for itself: green AND wired into a gate. Both now hold.
          -- `compare-match --gate` runs in deploy.sh (#9) and prints GATE GREEN
          -- over 35 days / 208 legs / 28 deltas, each signed off on all three
          -- axes a leg can move in (#401). 71e5544efa614a06 — the leg this
          -- rollback was measured on — is bit-clean since #406.
          --
          -- What is NOT claimed: that a live day cannot still surprise us. That
          -- leg served for ten days before anyone looked, on a day the corpus
          -- does not contain, and the gate is evidence about the corpus. What
          -- changed is that the same class of divergence now fails a deploy
          -- instead of accumulating unread.
          --
          -- ⚠ NO `LEAN_CALL_TIMEOUT_MS` ON THE REQUEST PATH, by design — the
          -- interactive path must never stall a request, so the 5 s default
          -- stands while the cron carries 30 s. The matcher's heaviest measured
          -- leg is 4838 ms, 97% of that ceiling, so expect occasional timeouts
          -- falling back to TS under load. Warned and ledgered, and harmless:
          -- the two arms' lines differ by <=0.14 m across the whole corpus, so
          -- a fallback draws an imperceptibly different pavement line, not a
          -- different route. This is why the timeout is NOT in this shared list.
          name = "LEAN_MATCH"
        , value = lit "on"
        }
      , { -- Verified Lean rail shortest path (Verified.Rail.dijkstraC, proved
          -- correct AND complete).
          --
          -- On the server this fires only on the miss-driven route-cache fill
          -- for a first-seen route (rail-route-fill.ts, #363) — the railSnap
          -- pass itself is an indexed cache lookup. Bulk volume is in
          -- 07-rail-refresh.yaml, which prints the ledger.
          --
          -- PROMOTED shadow->on 2026-08-06 (#432). The soak this asked for came
          -- from 07-rail-refresh, where the volume is: EXACT over 28 calls in a
          -- 21-day window, 0 failures.
          name = "LEAN_RAIL"
        , value = lit "on"
        }
      , { -- Verified Lean GPS Kalman filter
          -- (Verified.Geo.Kalman.filterGpsTrack). It runs on every velocity
          -- compute; golden 32/32 byte-identical, truth 295 held, walk ratchet
          -- 0/0/0/0, decoder scoreboard OK, ~7 ms median per compute (~1% of a
          -- run).
          --
          -- It is the first tenant with a genuinely non-zero divergence class.
          -- Lean's `Float.cos` and V8's `Math.cos` disagree by 1 ULP on ~7.6%
          -- of real latitudes, `metersToDegreesLon` calls `cos`, and the
          -- covariance recursion carries that into `lon` on ~0.5% of rows
          -- (femtometres — far under the 1e-7° display grid). Two libms cannot
          -- be reconciled, so the per-day `lean-kalman[...]` ledger grades
          -- EXACT / ULP / DIVERGED and reserves DIVERGED for the thing no ULP
          -- story explains: the two arms keeping DIFFERENT fixes.
          --
          -- PROMOTED shadow->on 2026-08-06 (#432) after a 9-day soak
          -- (07-26..08-03) reading 9/9 clean — 4 EXACT, 5 in the ULP band,
          -- bearing <=5.7e-14 deg, ZERO length diffs, and no swallowed bridge
          -- failure on any tenant in the window. The one open item,
          -- `+1 stationary-bearing` on 08-03, is #394 — a fabricated heading at
          -- speed 0 that BOTH arms emit, so it is not a divergence.
          name = "LEAN_KALMAN"
        , value = lit "on"
        }
      , { -- Verified Lean GPS quality pre-filter
          -- (Verified.Geo.GpsQuality.qualityFilterGps) — the incoherent-run
          -- dropper that runs one call ABOVE the Kalman filter.
          --
          -- Unlike the tenants above it this one has an EXACT gate rather than
          -- a bounded-ULP one, and the reason is structural: the filter is
          -- drop-only. Every fix it emits is a copy of an input fix, never a
          -- computed value. Inputs cross the bridge as IEEE bit patterns, so
          -- both arms select from bit-identical candidates and `cos` reaches
          -- only the threshold comparisons. `compare-gpsquality` is 32/32 days
          -- agreeing exactly on the keep-set.
          --
          -- So the ledger has TWO levels, not three: there is no expected
          -- divergence class to grade, and anything other than EXACT is a
          -- DECISION flip — the two arms disagreeing about whether a run is
          -- garbage. If one appears, adjudicate which arm is right; do not
          -- widen the verdict to quiet it.
          --
          -- PROMOTED shadow->on 2026-08-06 (#432). EXACT every day it was seen
          -- across the 9-day window, 0 failures.
          name = "LEAN_GPSQUALITY"
        , value = lit "on"
        }
      , { -- Verified Lean biometric label rewrites
          -- (Verified.Geo.BiometricLabels) — the four velocity passes that let
          -- the step counter overrule what GPS decided about a segment's mode:
          -- cadenceCorrect, revertIsolatedCadence, jitterWalkToStay,
          -- walkThrough. Four passes behind one flag because they are one port
          -- of one TS module, and splitting them would mean four soaks of a
          -- surface that shares every threshold. Five CALL SITES, since
          -- revertIsolatedCadence runs twice — before and after the rail
          -- annotators — and both are served.
          --
          -- EXACT gate, like LEAN_GPSQUALITY and for a related reason: every
          -- output is a discrete label, an index, or a `toFixed` rendering —
          -- never a fresh real. The reason strings go through
          -- Verified.JsNum.toFixed, which implements the ECMA-262 rounding rule
          -- against the double's exact binary value, so even the formatted
          -- numbers are compared exactly rather than to a tolerance.
          --
          -- The one place a libm difference could reach a decision is the
          -- stay-extent veto in correctStationaryWalkThrough — a haversine max
          -- against an 80 m threshold — and only for a segment whose extent
          -- sits within 1 ULP of exactly 80 m.
          --
          -- PROMOTED shadow->on 2026-08-06 (#432). EXACT every day it was seen,
          -- 5 calls/day (one per call site), 0 failures.
          name = "LEAN_BIOLABELS"
        , value = lit "on"
        }
      ]

in  T.namespaceOf
      (     { name = "health"
      , cluster = T.Cluster.isis
      , db = Some
        { dbName = "health"
        , -- ~4 GB today, `heart_rate_intraday` alone ~2.6 GB.
          storageGi = 10
        , -- The only database in the fleet that sets one. `requests.memory`
          -- below covers this plus mariadbd's overhead, and the two move
          -- together.
          innodbBufferPoolGi = Some
            2
        , resources =
          { requests =
            { cpu = "100m"
            , -- 2 GB pool + mariadbd overhead.
              memory = "2304Mi"
            }
          , -- THE ONE `None` IN THE FLEET, and the reason `T.DbResources`
            -- exists: a hard cap risks an OOM-kill mid-query on a ~4 GB
            -- database, and isis has ample headroom (~12 GB free). dev-lint
            -- agrees — `image_profile` sets `require_memory_limit = false` for
            -- every `is_db` container — so this is stating a position the
            -- linter already holds, not carving an exemption out of it.
            limits = None T.Limits
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
            T.Reach.Ingress { host = dns.health, exposure = T.Exposure.Public }
        , name = "health-auth"
        , image = T.Image.Fleet "health-sync"
        , command = Some [ "node", "dist/server.js" ]
        , port
        , uid = 1000
        , hardening = T.Hardening.NonRoot
        , -- MEASURED, not assumed — see the header. The nine `allow-rootfs-rw`
          -- waivers in this tree go away with it.
          readOnlyRootFs = True
        , env =
              [ { name = "AUTH_PORT", value = lit "${Natural/show port}" }
              , { name = "DB_HOST", value = lit "health-db" }
              , { name = "DB_NAME", value = lit "health" }
              , { name = "DB_USER", value = secret keys.DB_USER }
              , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
              , { name = "FITBIT_CLIENT_ID"
                , value = secret keys.FITBIT_CLIENT_ID
                }
              , { name = "FITBIT_CLIENT_SECRET"
                , value = secret keys.FITBIT_CLIENT_SECRET
                }
              , { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
              , { name = "NC_CLIENT_SECRET"
                , value = secret keys.NC_CLIENT_SECRET
                }
              , { name = "SESSION_SECRET", value = secret keys.SESSION_SECRET }
              , { -- Comma-separated PhoneTrack session tokens allowed through
                  -- the Owntracks proxy. Requests with any other token are
                  -- rejected before reaching Nextcloud — protects both NC's
                  -- brute-force counter and the proxy's in-process state.
                  name = "OWNTRACKS_ALLOWED_TOKENS"
                , value = secret keys.OWNTRACKS_ALLOWED_TOKENS
                }
              , { -- Shared secret gating the /internal service API — the coach
                  -- app reads the user's places to auto-select a training
                  -- location. Provisioned into health-secret out-of-band;
                  -- optional so the pod still starts if absent (then /internal
                  -- rejects every request).
                  name = "SERVICE_TOKEN"
                , value = optionalSecret keys.SERVICE_TOKEN
                }
              ]
            # decodeFlags
            # [ { -- Building-escape walk corrector (case-based: route a drawn
                  -- walk around building blocks it falsely crosses; leave
                  -- genuine visits — doorsteps, hospitals, concourses — alone).
                  -- Display-geometry only; measured on the 2026-07-01 fixture
                  -- before enabling. ON by default in code since 2026-07-02 (an
                  -- opt-in flag made local replays diverge from prod); "0" is
                  -- the emergency off-switch, so the explicit "1" here is
                  -- documentation, not activation.
                  --
                  -- NOT in `decodeFlags`: the cron does not carry it.
                  name = "WALK_BUILDING_ESCAPE"
                , value = lit "1"
                }
              ]
            # leanTenants
        , probeTiming =
            -- Readiness is the live tree's own 3/10 rather than
            -- `T.standardTiming`'s 5/10: it is behind an Ingress with no
            -- hostPort, so it CAN roll, and a shorter delay is free.
            { readiness = { initialDelaySeconds = 3, periodSeconds = 10 }
            , liveness = { initialDelaySeconds = 15, periodSeconds = 20 }
            }
        , -- ⚠ A LIVENESS PROBE IS NEW — the live Deployment has readiness only.
          -- Safe on this app specifically, and worth stating why rather than
          -- leaving it to be re-derived: a `tcpSocket` check is answered by the
          -- kernel's accept queue, not by node's event loop, so the velocity
          -- pipeline's long CPU bursts (~6 CPU-seconds for a busy day, and a
          -- measured 40 s wall-clock when it was CFS-throttled) cannot fail it.
          -- What it catches is a process that is alive but no longer listening,
          -- and it needs three consecutive failures at 20 s to act.
          --
          -- `Tcp`, not `Http`: there is no health endpoint, and probing `/`
          -- would run the session middleware on every tick.
          probe = T.Probe.Tcp { port }
        , resources =
          { requests =
            { -- Idle most of the time; a /api/velocity compute is a short CPU
              -- burst. Modest but non-trivial.
              cpu = "250m"
            , memory = "128Mi"
            }
          , limits =
            Some { -- The velocity pipeline is CPU-bound (map-matchers / HMM decode):
              -- ~6 CPU-seconds for a busy day. A 200m cap CFS-throttled that to
              -- ~50 s wall-clock (measured: walkMatch 4 s of CPU → 40 s
              -- on-pod). 2 cores lets a compute finish in a few seconds; isis
              -- sits ~7%.
              cpu = Some "2"
            , -- Headroom for the local-OSM-mirror cold start: multiple large
              -- Overpass responses (5-50 MB each) can be in flight while
              -- filling osm_points / osm_lines for a new bbox. Steady state
              -- stays well under this.
              memory = "512Mi"
            }
          }
        , volumes = [] : List T.Volume
        , mounts = [] : List T.VolumeMount
        , tasks =
            -- The six recurring jobs. `dbEnv` is every task's floor — all of them
            -- read and write the same database — and the extras are per task.
            --
            -- ⚠ The two one-shot Jobs in the live tree (`health-decode-backfill-v7`,
            -- `health-decode-redecode-20260731`) are NOT here and should not be. A
            -- Job's spec is immutable, so re-rendering one with today's flags makes
            -- `apply` fail rather than update; their names encode a run rather than
            -- a service; and `backfill-v7` still carries the pre-2026-08-06 env with
            -- no LEAN_* tenants at all, which is a record of how that run decoded
            -- and NOT a policy anything should reproduce. They are spent, and
            -- retiring them is a decision about the cluster, not about the model.
            [ { -- Every 15 min so Fitbit data (esp. sleep, which Fitbit only
                -- finalizes after you wake) appears within ~15 min instead of up to
                -- an hour. Each run re-queries a 2-day overlap (SYNC_OVERLAP_DAYS);
                -- ~15 calls/run x 4 runs/hr stays well under Fitbit's 150
                -- req/hr/user.
                name = "health-sync"
              , schedule = "*/15 * * * *"
              , command = [ "node", "dist/sync.js" ]
              , -- 55 min: under the 15-min cadence a run that outlives four of its
                -- own successors is wedged, and `Forbid` means those four never
                -- started.
                deadlineSeconds = 3300
              , suspended = False
              , volumes = [] : List T.Volume
              , mounts = [] : List T.VolumeMount
              , env =
                    dbEnv
                  # [ { name = "FITBIT_CLIENT_ID"
                      , value = secret keys.FITBIT_CLIENT_ID
                      }
                    , { name = "FITBIT_CLIENT_SECRET"
                      , value = secret keys.FITBIT_CLIENT_SECRET
                      }
                    , { -- Google Health weight sync (#260). GH_USER_ID names the
                        -- health-sync user the Google account belongs to.
                        name = "GH_USER_ID"
                      , value = lit "pippijn"
                      }
                    , { -- ⚠ A SECRET THIS MODEL DOES NOT OWN. The refresh token is
                        -- long-lived (OAuth app published 2026-07-18) and the
                        -- credentials are managed by hand in `health-google`, so
                        -- they are not in `secrets` above and `secret.sh` does not
                        -- write them. `FromUnmanagedSecret` is how that is said out
                        -- loud instead of being a name that happens to differ.
                        name = "GH_CLIENT_ID"
                      , value = google "GH_CLIENT_ID"
                      }
                    , { name = "GH_CLIENT_SECRET"
                      , value = google "GH_CLIENT_SECRET"
                      }
                    , { name = "GH_REFRESH_TOKEN"
                      , value = google "GH_REFRESH_TOKEN"
                      }
                    ]
              , resources =
                { requests = { cpu = "50m", memory = "128Mi" }
                , limits = Some { cpu = Some "500m", memory = "512Mi" }
                }
              }
            , { name = "health-focus-refresh"
              , -- Weekly, Sunday 04:00.
                schedule = "0 4 * * 0"
              , command = [ "node", "dist/cli/refresh-focus-places.js" ]
              , deadlineSeconds = 3300
              , suspended = False
              , volumes = [] : List T.Volume
              , mounts = [] : List T.VolumeMount
              , env = dbEnv # ncEnv
              , resources =
                { requests = { cpu = "50m", memory = "128Mi" }
                , limits = Some { cpu = Some "500m", memory = "512Mi" }
                }
              }
            , { name = "health-rail-refresh"
              , schedule = "0 5 * * *"
              , command = [ "node", "dist/cli/refresh-rail-routes.js" ]
              , -- 90 min. This is where the verified rail search runs in BULK — the
                -- decode's railSnap pass is only an indexed lookup into what this
                -- job filled.
                deadlineSeconds = 5400
              , suspended = False
              , volumes = [] : List T.Volume
              , mounts = [] : List T.VolumeMount
              , env =
                    [ { name = "LEAN_RAIL", value = lit "on" }
                    , leanCallTimeout
                    ]
                  # dbEnv
                  # ncEnv
              , resources = batchResources
              }
            , { name = "health-bus-refresh"
              , schedule = "30 5 * * *"
              , command = [ "node", "dist/cli/refresh-bus-routes.js" ]
              , deadlineSeconds = 5400
              , -- SUSPENDED, and the reason is now a DEPLOY dependency rather than
                -- an open question. Resume this the moment the health image ships
                -- the per-tile write; nothing else is outstanding.
                --
                -- Resumed on 2026-08-14 and re-suspended the same hour. The fix
                -- that makes unattended running safe — a partial run replaces only
                -- the tiles that ANSWERED and leaves the rest their rows
                -- (`refresh-bus-routes.ts`) — was verified against the prod DB from
                -- a LOCAL build: 4 of 18 tiles lost, mirror 995 -> 1000 routes.
                -- The cluster runs the deployed image, which predates it, so the
                -- catch-up run this un-suspend triggered used the OLD count
                -- threshold, refused (`1000 -> 652`), exited 1 and crashlooped.
                --
                -- Nothing was damaged — the old guard refuses rather than
                -- overwrites, and the mirror still holds its 1000 rows. The lesson
                -- is narrower and worth keeping: verifying a fix against the prod
                -- DATABASE says nothing about what the prod IMAGE will do. health
                -- is 30+ commits ahead of origin and blocked behind its golden
                -- gates (#813), so this cannot resume until that ships.
                --
                -- Overpass 504s are routine, not a fault: runs on 2026-08-14 lost
                -- 1, 6, 4 and 8 of 18 tiles. Under the per-tile write that is a
                -- normal night; under the count threshold it is a refusal.
                suspended = True
              , volumes = [] : List T.Volume
              , mounts = [] : List T.VolumeMount
              , env = dbEnv
              , resources = batchResources
              }
            , { name = "health-decode-recent"
              , schedule = "0 6 * * *"
              , command =
                [ "sh"
                , "-c"
                ,     "node dist/cli/decode-day.js --user pippijn "
                  ++  "--tz Europe/London --days 7 && "
                  ++  "node dist/cli/refresh-presence-log.js 90"
                ]
              , -- 30 min, and the tightest deadline here on purpose: this is the
                -- job an expensive Lean tenant blows first. The matcher's move off
                -- Lean `Int` to `Nat` was forced by a run that missed it.
                deadlineSeconds = 1800
              , suspended = False
              , volumes = [] : List T.Volume
              , mounts = [] : List T.VolumeMount
              , env =
                    dbEnv
                  # ncEnv
                  # decodeFlags
                  # [ { name = "LEAN_HSMM", value = lit "shadow" }
                    , { name = "LEAN_STATIONCHAIN", value = lit "on" }
                    ]
                  # leanTenants
                  # [ leanCallTimeout ]
              , resources = decodeResources
              }
            , { name = "health-rail-stops-refresh"
              , schedule = "0 6 * * *"
              , command = [ "node", "dist/cli/refresh-rail-stops.js" ]
              , deadlineSeconds = 5400
              , suspended = False
              , volumes = [] : List T.Volume
              , mounts = [] : List T.VolumeMount
              , env = dbEnv
              , resources = batchResources
              }
            ]
        }
      , secrets = toMap keys
      , -- The namespace has no policy of its own, which `generate.sh` records as
        -- the `allow-no-netpol` waiver. Hardening it is network-hardening work
        -- and wants the batch workloads modelled first — a default-deny egress
        -- written against the auth pod alone would state something false about
        -- the six crons that dial Fitbit, Overpass and the rail feeds.
        netpol = T.Netpol.Unpoliced
      }
          : T.App
      )
