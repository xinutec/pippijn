let T =
      -- health.xinutec.org — the health app (a Rust server over a verified Lean
      -- core, serving an Angular frontend; the TypeScript backend is gone, #975).
      --
      -- `decodeFlags` below is a `let` because the CronJobs, not yet modelled here,
      -- must carry the same env (see 08-decode-recent.yaml).
      --
      -- ⚠⚠ NOT DEPLOYABLE YET. This tree emits `health-db-from-app-only`, admitting
      -- 3306 from `app: health-auth` alone — and six CronJobs talk to that database
      -- under their own labels, so applying it cuts every batch workload off from its
      -- data at 04:00. Modelling them with `T.ScheduledTask` is part of the same
      -- increment, not the next one.
      --
      -- ⚠ `rootFs = T.RootFs.ReadOnly` is a CHANGE to the live Deployment, measured:
      -- the app writes nothing to its overlay. It retires nine `allow-rootfs-rw`
      -- waivers.
      ../lib/types.dhall

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

let google =
      -- The Google Health credentials, which live in a secret this model does not
      -- manage. See `T.EnvValue.FromUnmanagedSecret`.
      λ(k : Text) →
        T.EnvValue.FromUnmanagedSecret
          { secret = "health-google", key = k, optional = False }

let dbEnv
    : List T.EnvVar
    =
      -- Every batch task reads and writes the same database, so this is their floor
      -- rather than something each restates.
      [ { name = "DB_HOST", value = lit "health-db" }
      , { name = "DB_NAME", value = lit "health" }
      , { name = "DB_USER", value = secret keys.DB_USER }
      , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
      ]

let ncEnv
    : List T.EnvVar
    =
      -- Nextcloud OAuth, for the jobs that read places out of it.
      [ { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
      , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
      ]

let tmpVolume
    : List T.Volume
    =
      -- The nightly refreshes walk the window a day at a time, each carrying a full
      -- velocity computation: a WORKING SET, not a leak. Sized for headroom over the
      -- observed peak, which is a LOWER BOUND — a sample cannot see between samples.
      --
      -- ⚠ AN OOMKILL HERE READS AS A NETWORK FAILURE. SIGKILL gives the process no
      -- chance to print, so the log STOPS mid-scan and the last visible line is an
      -- unrelated `velocity … INFEASIBLE` warning that looks like a cause.
      -- ⚠ A WRITABLE /tmp FOR THE CRONS TOO. `rootFs` is ReadOnly and the Lean serve
      -- path opens a `tempfile()` to capture Lean's stderr, so any job that reaches
      -- the day pipeline dies with "Read-only file system (os error 30)" without it.
      --
      -- ⚠ And it fails QUIETLY: a day that dies this way pools 0 routes, upserts 0,
      -- and exits 0 (#1106).
      --
      -- Given to every cron rather than the subset that provably needs it: an
      -- emptyDir costs nothing, and picking by inspection is how one gets missed.
      [ { name = "tmp", source = T.VolumeSource.EmptyDir } ]

let tmpMount
    : List T.VolumeMount
    = [ { name = "tmp"
        , mountPath = "/tmp"
        , subPath = None Text
        , readOnly = False
        }
      ]

let batchResources
    : T.Resources
    = { requests = { cpu = "100m", memory = "256Mi" }
      , limits = Some { cpu = Some "1000m", memory = "2Gi" }
      }


let decodeResources
    : T.Resources
    =
      -- The decode carries more memory than the refreshes: it holds a day's fixes and
      -- both arms of every shadowed Lean pass at once.
      --
      -- A long-lived `verified_cli` grows across the window, with a `day-shell`
      -- spawned per call on top; the shell is transient, not a leak, so this is a
      -- headroom problem rather than a bound to tighten.
      --
      -- ⚠ TOO LOW IS A CRASH LOOP, NOT A SLOW RUN. The job restarts from day one on
      -- every OOMKill (exit 137), so it never finishes.
      { requests = { cpu = "100m", memory = "256Mi" }
      , limits = Some { cpu = Some "1000m", memory = "3Gi" }
      }

let decodeFlags
    : List T.EnvVar
    =
      -- C4 continuity flags (#224). ⚠ The auth pod does not READ them — the decode
      -- does — but `scripts/prod-db.sh` mirrors the pod env via printenv, so a Mac
      -- replay decodes the same day the cron wrote. Rationale and the open defect
      -- (#366) are at the cron: kubes/health/k8s/08-decode-recent.yaml.
      [ { name = "USE_CADENCE_IMPUTATION", value = lit "1" }
      , { name = "USE_SEGMENT_EVIDENCE", value = lit "1" }
      , { name = "USE_CHAIN_CONTEXT", value = lit "1" }
      , { name = "USE_REACQUIRE_ROBUST_SPEED", value = lit "1" }
      ]

in  T.namespaceOf
      (     { name = "health"
      , placement = T.on T.Cluster.isis
      , db = Some
        { dbName = "health"
        , -- ~4 GB today, `heart_rate_intraday` alone ~2.6 GB.
          storageGi = 10
        , -- The larger of the fleet's two pools; `signal-db` sets 1 GiB since
          -- IRC ingestion took its archive to 3.7M rows. `requests.memory`
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
          , -- The reason `T.DbResources` exists: a hard cap risks an OOM-kill
            -- mid-query on a ~4 GB database, and isis has headroom. dev-lint
            -- agrees —
            -- `image_profile` sets `require_memory_limit = false` for every
            -- `is_db` container — so this is stating a position the linter
            -- already holds, not carving an exemption out of it.
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
        T.Workload::{ reach =
            T.Reach.Ingress { host = dns.health, exposure = T.Exposure.Public }
        , name = "health-auth"
        , image = T.Image.Fleet "health-sync"
        , -- The Rust+Lean HTTP server (#982).
          --
          -- ⚠ REVERTING IS NOT ONE LINE. The Dockerfile ships no `dist/` at
          -- all since the TypeScript backend was deleted (#975), so going back
          -- means building one first.
          --
          -- ⚠ It reads AUTH_PORT, the one set below — NOT PORT, whose 8081
          -- fallback would bind the wrong port behind a Service expecting 3000.
          --
          -- ⚠ It needs the writable /tmp mounted below: without it every
          -- `/velocity` returns 400 while the pod stays 1/1 Running (#1106).
          --
          -- That and the migration-lock defect (#1108) are checked BEFORE a
          -- cutover, against the real securityContext and the real database, by
          -- `health/scripts/check-serving-conditions.sh`.
          command = Some [ "bin/backend", "serve" ]
        , port
        , uid = 1000
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- MEASURED, not assumed — see the header. The nine `allow-rootfs-rw`
          -- waivers in this tree go away with it.
          rootFs = T.RootFs.ReadOnly
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
            -- ⚠ NO `WALK_*` FLAG BELONGS HERE (#1268). They are Lean `Flags`
            -- fields (`Verified.Geo.WalkAnnotate`) that no request populates and
            -- no shell sets, so setting one changes nothing — and an operator
            -- would discover that during the emergency it was meant for. The
            -- corrector is ON unconditionally; a switch nothing reads is not an
            -- off-switch.
        , probeTiming =
            -- Readiness is the live tree's own 3/10 rather than
            -- `T.standardTiming`'s 5/10: it is behind an Ingress with no
            -- hostPort, so it CAN roll, and a shorter delay is free.
            { readiness = { initialDelaySeconds = 3, periodSeconds = 10 }
            , liveness = Some { initialDelaySeconds = 15, periodSeconds = 20 }
            }
        , -- ⚠ A LIVENESS PROBE IS NEW — the live Deployment has readiness only, and
          -- it is safe HERE because a `tcpSocket` check is answered by the kernel's
          -- accept queue rather than the event loop, so the velocity pipeline's long
          -- CPU bursts cannot fail it. What it catches is a process alive but no
          -- longer listening.
          --
          -- `Tcp`, not `Http`: there is no health endpoint, and probing `/` would
          -- run the session middleware on every tick.
          probe = T.Probe.Tcp { port }
        , resources =  Some
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
        , -- ⚠ A WRITABLE /tmp, because `rootFs` above is ReadOnly and the Lean
          -- serve path opens a `tempfile()` to capture Lean's stderr. Without
          -- this, every `/velocity` returns 400 with "Read-only file system"
          -- while the pod stays 1/1 Running and passes readiness — only the
          -- route that runs the fold touches it (#1106).
          --
          -- An `emptyDir`, NOT a relaxation of `rootFs`: the read-only root is
          -- measured hardening that nine `allow-rootfs-rw` waivers depend on,
          -- and this gives the process a scratch area without giving it its own
          -- code back.
          volumes = [ { name = "tmp", source = T.VolumeSource.EmptyDir } ]
        , mounts =
          [ { name = "tmp"
            , mountPath = "/tmp"
            , subPath = None Text
            , readOnly = False
            }
          ]
        , tasks =
            -- The recurring jobs. `dbEnv` is every task's floor — all of them
            -- read and write the same database — and the extras are per task.
            --
            -- ⚠ The live tree's two one-shot Jobs are NOT here and must not be: a
            -- Job's spec is IMMUTABLE, so re-rendering one with today's flags makes
            -- `apply` fail rather than update, and its env records how one run
            -- decoded rather than a policy to reproduce. Retiring them is a decision
            -- about the cluster, not the model.
            [ { -- Every 15 min so Fitbit data (esp. sleep, which Fitbit only
                -- finalizes after you wake) appears within ~15 min instead of up to
                -- an hour. Each run re-queries a 2-day overlap (SYNC_OVERLAP_DAYS);
                -- ~15 calls/run x 4 runs/hr stays well under Fitbit's 150
                -- req/hr/user.
                name = "health-sync"
              , schedule = "*/15 * * * *"
              , -- Tier 2 of #982. The Fitbit + PhoneTrack ingestion, on the
                -- Rust binary.
                --
                -- ⚠ `migrate()` is absent here ON PURPOSE — `backend serve`
                -- performs it.
                --
                -- ⚠ The backfill loop CANNOT run in production: all nine
                -- streams carry `complete = true`, and both walks short-circuit
                -- on that. Clearing a flag is what would exercise an untested
                -- path, not this switch.
                command = [ "bin/backend", "sync" ]
              , -- 55 min: under the 15-min cadence a run that outlives four of its
                -- own successors is wedged, and `Forbid` means those four never
                -- started.
                deadlineSeconds = 3300
              , suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
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
                        -- long-lived and the credentials are managed by hand in
                        -- `health-google`, so
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
              , -- Rust+Lean (#982 Tier 2).
                --
                -- A few labels differ from the node arm, all low-visit clusters in
                -- dense venue areas, and are #343's subject rather than a port
                -- defect: on a one-visit cluster with four candidates inside
                -- the 12 m near field, which name wins is unstable in EITHER
                -- arm. One of the three is production being wrong -- it names a
                -- venue the mirror holds nowhere within 500 m of that centroid,
                -- and the Rust arm declines to name it.
                --
                -- It also carries a guard the node arm lacks: it REFUSES to
                -- write when a PhoneTrack device fetch failed, because the
                -- write path ends in DELETE and a partial history silently
                -- drops real places (#1140).
                command = [ "bin/backend", "refresh-focus-places" ]
              , deadlineSeconds = 3300
              , suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
              , env = dbEnv # ncEnv
              , resources =
                { requests = { cpu = "50m", memory = "128Mi" }
                , limits = Some { cpu = Some "500m", memory = "512Mi" }
                }
              }
            , { name = "health-rail-refresh"
              , schedule = "0 5 * * *"
              , -- Rust+Lean (#982 Tier 2).
                --
                -- ⚠ The whole corridor snap runs in Lean (`Verified.Geo.RailSnap`,
                -- 123 guards) via the `railsnap` mode: Rust hands over raw ways,
                -- stations and the pooled fix cloud. The node arm builds the
                -- graph itself and asks Lean only for `dijkstraC`.
                --
                -- ⚠ It REFUSES to report success when every scanned day failed to
                -- compute — otherwise it pools 0 routes and exits 0 (#1134).
                command = [ "bin/backend", "refresh-rail-routes" ]
              , -- 90 min: the verified rail search runs in BULK here, and the
                -- decode's railSnap pass is only a lookup into what this fills.
                deadlineSeconds = 5400
              , suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
              , env = dbEnv # ncEnv
              , resources = batchResources
              }
            , { name = "health-bus-refresh"
              , schedule = "30 5 * * *"
              , -- Tier 2 of #982: the extraction is Lean.
                command = [ "bin/backend", "refresh-bus-routes" ]
              , deadlineSeconds = 5400
              , -- ⚠ OVERPASS 504s ARE ROUTINE, NOT A FAULT — a normal night loses
                -- several of the 18 tiles. Unattended running is safe because a
                -- partial run replaces only the tiles that ANSWERED and leaves
                -- every other tile its rows, so a 504 cannot shrink the mirror.
                -- A count threshold over the whole table would refuse instead.
                suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
              , env = dbEnv
              , resources = batchResources
              }
            , { name = "health-decode-recent"
              , schedule = "0 6 * * *"
              , command =
                [ "sh"
                , "-c"
                ,     -- ⚠ NO `--tz`. The Rust arm reads `home_tz` from
                      -- `sync_state` rather than taking it on the command line,
                      -- so the zone cannot drift from what the rest of the
                      -- pipeline uses.
                      --
                      -- ⚠ 7 IS EXPLICIT because node's was. The Rust default is
                      -- 14; leaving it off would quietly double the window.
                      "bin/backend decode-day pippijn 7 && "
                  -- Tier 2 of #982: the rollup is Lean.
                  ++  "bin/backend refresh-presence-log 90"
                ]
              , -- 30 min, and the tightest deadline here on purpose: this is the
                -- job an expensive Lean tenant blows first, so a slow one should
                -- be caught here rather than absorbed. The run uses about a fifth
                -- of it.
                deadlineSeconds = 1800
              , suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
              , env = dbEnv # ncEnv # decodeFlags
              , resources = decodeResources
              }
            , { name = "health-rail-stops-refresh"
              , schedule = "0 6 * * *"
              , -- Tier 2 of #982, alongside bus-refresh above.
                --
                -- ⚠ IT WRITES PER `tile_key`, and must. Without that a partial run
                -- DELETEs the whole table and rewrites only the tiles that
                -- answered, so consecutive runs cache wildly different sets — and
                -- a count going UP hides it. #1134, #1153.
                command = [ "bin/backend", "refresh-rail-stops" ]
              , deadlineSeconds = 5400
              , suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
              , env = dbEnv
              , resources = batchResources
              }
            , { -- Did the biometric streams actually ARRIVE? (health #1231)
                --
                -- A stream can stop while `health-sync` exits 0 on every run, with
                -- the only trace one ERROR line in a pod log nothing reads.
                --
                -- ⚠ An error-string watcher would not catch that: a stream that
                -- writes nothing WITHOUT erroring looks identical from outside.
                -- This asks the only question that generalises, over all eleven
                -- streams, and exits NON-ZERO with their names.
                name = "health-freshness"
              , -- Daily, 09:00. ⚠ NOT more often: every bound is in DAYS (the
                -- tightest is 3), so a 15-minute cadence would re-ask a question
                -- whose answer cannot change and turn one stale stream into 96
                -- failed Jobs a day.
                schedule = "0 9 * * *"
              , command = [ "bin/backend", "freshness" ]
              , -- Eleven `MAX(date)` reads over one connection. The 300 s is for a
                -- database that is slow, not for work.
                deadlineSeconds = 300
              , suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
              , -- ⚠ `dbEnv` ONLY. It reads `MAX(date)` and nothing else; giving it
                -- the Fitbit or Google credentials would let a check that exists to
                -- observe the syncs become able to perform one.
                env = dbEnv
              , resources = batchResources
              }
            , { -- Fetch the reverse geocodes the SERVING path could not answer
                -- (health #1076).
                --
                -- The fold declines a lookup it has no data for and records the
                -- miss in `osm_fetch_queue`; this drains it. Fetching inline would
                -- put a Nominatim round trip on the serving path, which is where
                -- the fold's latency already hurts (#1071) — the split is the
                -- whole design, so a day is blank once and right afterwards.
                --
                -- ⚠ THIS CHANGES WHAT SERVED DAYS ARE NAMED, so it is not a silent
                -- tidy-up. It was Pippijn's decision to schedule it, and the run
                -- prints what it fetched: a cron whose effect is invisible in its
                -- own log would be the wrong shape for work like this.
                name = "health-geocode-fetch"
              , -- Daily, 07:00 — after `health-decode-recent` and the rail-stops
                -- refresh at 06:00, before `health-freshness` at 09:00.
                --
                -- ⚠ NOT more often. The queue fills when a day is SERVED, which is
                -- when he opens one, and Nominatim allows ONE REQUEST PER SECOND —
                -- so the useful cadence is set by how fast the queue fills, not by
                -- how fast it could be drained.
                schedule = "0 7 * * *"
              , -- ⚠ THE LIMIT IS EXPLICIT even though 200 is the default, because
                -- it is the bound that keeps one run polite: 200 keys per zoom at
                -- one request per second is a few minutes of traffic. A backlog
                -- larger than that drains over several nights, which is correct —
                -- there is nothing urgent about a name on a day already served.
                command = [ "bin/backend", "fetch-geocodes", "--limit", "200" ]
              , -- Generous against the rate limit rather than against work: the
                -- worst case is ~400 s of deliberate sleeping.
                deadlineSeconds = 1800
              , suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
              , -- ⚠ `dbEnv` ONLY. Nominatim needs no credential — it is identified
                -- by User-Agent — so this job holds nothing that could write to a
                -- health stream.
                env = dbEnv
              , resources = batchResources
              }
            , { -- Fill the base OSM mirror where the SERVING path found no
                -- coverage (health #1658).
                --
                -- The same queue and the same split as `health-geocode-fetch`
                -- above, for the other half of what a fold cannot answer. Until
                -- this existed NOTHING in the tree wrote `osm_lines`,
                -- `osm_points` or `osm_coverage`: the base mirror was a dead
                -- snapshot of whatever the TypeScript left (health #975), so
                -- every place he went that it had never fetched stayed blank
                -- permanently and degraded further as OSM changed underneath it.
                --
                -- ⚠ THIS CHANGES WHAT SERVED DAYS SHOW, more than the geocode
                -- drain does: it decides whether a walk is drawn at all and
                -- whether a train leg gets its station pair. Same standard as
                -- above — the run prints every box it fetched.
                name = "health-osm-fetch"
              , -- Daily, 07:30 — after the geocode drain at 07:00 and well clear
                -- of the bus refresh at 05:30 and the rail refreshes at 05:00 and
                -- 06:00.
                --
                -- ⚠ THE SPACING IS THE POINT, not the half hour. Overpass allows
                -- this client TWO concurrent slots and every job here competes
                -- for them; health #1153 measured rail refusing twice as often as
                -- bus while running thirty minutes behind it, and named that
                -- ordering as the first thing to test if coverage regresses.
                schedule = "30 7 * * *"
              , -- ⚠ FORTY, against the geocode drain's 200, and the difference is
                -- the request. These are multi-megabyte Overpass queries against
                -- a two-slot endpoint — one 5 km highway box measured 8.9 MB and
                -- 15,387 ways — where a geocode is one point in one second.
                --
                -- It is not a throughput bound. `fetch-osm` re-asks the coverage
                -- gate per key and skips whatever a box it has already fetched
                -- now covers, so one box typically clears many keys: 40 is a
                -- generous day's worth of genuinely NEW ground.
                command = [ "bin/backend", "fetch-osm", "--limit", "40" ]
              , -- Sized against the endpoint, not the work: 40 boxes at up to
                -- 120 s of slot waiting plus a 90 s fetch budget each is the
                -- worst case, and it must fit without the job being killed
                -- mid-insert.
                deadlineSeconds = 5400
              , suspended = False
              , rootFs = T.RootFs.ReadOnly
              , volumes = tmpVolume
              , mounts = tmpMount
              , -- ⚠ `dbEnv` ONLY. Overpass needs no credential — it is identified
                -- by User-Agent — so this job holds nothing that could write to a
                -- health stream.
                env = dbEnv
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
