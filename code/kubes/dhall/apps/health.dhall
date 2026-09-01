let T =
      -- health.xinutec.org — the health app (a Rust server over a verified Lean
      -- core, serving an Angular frontend; the TypeScript backend is gone, #975).
      --
      -- The largest tree in the fleet and the only one with BATCH workloads: the
      -- CronJobs under `tasks` and two one-shot Jobs share this image and this
      -- environment. They are not modelled here yet (they need `T.ScheduledTask`),
      -- which is why one `let` below is exported-looking rather than inlined —
      -- `decodeFlags` is the env the crons must agree with, and the live manifests
      -- say so in prose today ("kept in step with 08-decode-recent.yaml"). The `let`
      -- is what stops that being luck. The pairwise check of 2026-08-12 also covered
      -- `leanTenants`, deleted 2026-08-29 as dead (health #1213): no Rust or Lean
      -- code reads a `LEAN_*` variable, so those entries selected between arms that
      -- no longer exist.
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
      -- ⚠ `rootFs = T.RootFs.ReadOnly` is a CHANGE to the live Deployment, and it is
      -- measured rather than assumed: the running container's overlay upper layer
      -- after 33h held six entries, every one a kubelet bind-mount (`/etc/resolv.conf`,
      -- the serviceaccount dir). The app wrote nothing. That measurement is what
      -- retires this tree's nine `allow-rootfs-rw` waivers, which stopped being inert
      -- on 2026-08-12 when dev-lint's `image_profile` dropped its `health-sync`
      -- exemption — the linter had been excusing an image the fleet builds.
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
      -- The nightly refreshes walk a 21-day window a day at a time, and each day
      -- carries a full velocity computation. That is a WORKING SET, not a leak.
      --
      -- 1Gi is simply below what the job needs. Measured on 2026-08-24 by re-running
      -- `health-rail-refresh` with the ceiling raised and sampling RSS every 20s:
      --
      --   at 6Gi   219 -> 273 -> 377 -> 384 -> 977Mi, completes (exit 0, 18 routes)
      --   at 2Gi   peak 1113Mi, completes in 840s (exit 0, 18 routes, 0 restarts)
      --
      -- 1113Mi is ABOVE the old 1Gi = 1024Mi ceiling, which is exactly why
      -- `health-rail-refresh` and `health-rail-stops-refresh` OOMKilled EVERY NIGHT
      -- from 2026-08-21 (#1133).
      --
      -- ⚠ Both figures are LOWER BOUNDS: a 20s sample cannot see a peak between
      -- samples, and the 6Gi run reported 977Mi where the 2Gi run reported 1113Mi for
      -- the same work. Do not treat either as the true maximum — 2Gi is chosen for
      -- the ~900Mi of headroom over the larger observation, not because 1113Mi is
      -- known to be the ceiling.
      --
      -- ⚠ It reads as a network failure and is not. SIGKILL gives the process no
      -- chance to print, so the log simply STOPS mid-scan with no error; the last
      -- visible line is an unrelated `velocity … INFEASIBLE` warning that looks like
      -- a cause. The task carried "overpass-api.de has banned isis's IP" for three
      -- days on that reading, while a curl FROM isis returned 200 in 0.52 s.
      --
      -- Same failure and same fix as `decodeResources` below, which was raised for
      -- exactly this on 2026-08-16. 2Gi is ~2x the measured peak; isis had ~6 GiB
      -- free when this was raised.
      -- ⚠ A WRITABLE /tmp FOR THE CRONS TOO. `rootFs` is ReadOnly and the Lean serve
      -- path opens a `tempfile()` to capture Lean's stderr, so any job that reaches
      -- the day pipeline dies with "Read-only file system (os error 30)" without it.
      --
      -- The Deployment got this on 2026-08-23 (#1106); the CronJobs did not, and
      -- nothing noticed until `refresh-rail-routes` ran on Rust for the first time on
      -- 2026-08-25 and EVERY ONE of its 22 days failed that way. It pooled 0 routes,
      -- upserted 0, and exited 0 — the node arm had never exercised this path because
      -- it computed days in-process rather than through the Lean fold.
      --
      -- Given to every cron rather than the four that provably need it: an emptyDir
      -- costs nothing, and picking the subset by inspection is how the Deployment's
      -- fix failed to reach these in the first place.
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
      -- 1536Mi was enough until the day tenant got a HOST (health `21957c0`). Measured
      -- in the pod on 2026-08-16, mid-run over `--days 7`: node 488M, a long-lived
      -- `verified_cli` growing 232M→411M across the seven days, and `day-shell`
      -- spawned per call at ~177M on top. That peak OOMKilled the job twice (exit
      -- 137), and it restarts from day one each time, so it never finishes — a
      -- crash loop, not a slow run.
      --
      -- `day-shell` is transient, not a leak: sampled every 25 s it appears at
      -- ~151-177M and disappears between calls. So this is a headroom problem and 3Gi
      -- fixes it; isis had ~6 GiB free when this was raised.
      { requests = { cpu = "100m", memory = "256Mi" }
      , limits = Some { cpu = Some "1000m", memory = "3Gi" }
      }

let decodeFlags
    : List T.EnvVar
    =
      -- C4 continuity flags (task #224). The auth pod does not READ them — it is the
      -- decode that does — but `scripts/prod-db.sh` mirrors the pod env via printenv
      -- so a Mac replay decodes the same day the cron wrote. A missing mirror is the
      -- exact feedback_parity_tools_must_mirror_env failure, so these are carried
      -- here deliberately. Rationale and the open defect (#366) are documented at the
      -- cron: kubes/health/k8s/08-decode-recent.yaml.
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
          , -- The reason `T.DbResources` existed: a hard cap risks an OOM-kill
            -- mid-query on a ~4 GB database, and isis has headroom (~6.7 GB
            -- available, measured 2026-08-14). dev-lint agrees —
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
          -- ⚠ REVERTING IS NOT ONE LINE. This comment said twice that the image
          -- ships `dist/server.js` beside this, so a revert was a re-apply with
          -- no rebuild. It has not been true since the TypeScript backend was
          -- deleted (#975): the Dockerfile ships no `dist/` at all, and a
          -- revert now means building one first. Corrected 2026-09-01.
          --
          -- ⚠ It reads AUTH_PORT, the same variable the TypeScript read and the
          -- one set below. It used to read PORT and fall back to 8081, which
          -- would have bound the wrong port behind a Service expecting 3000.
          --
          -- ⚠ It needs the writable /tmp mounted below. The first attempt at
          -- this flip, earlier on 2026-08-23, was reverted within the hour
          -- because /tmp was on the read-only root and every `/velocity`
          -- returned 400 while the pod stayed 1/1 Running (#1106).
          --
          -- Both that and the migration-lock defect (#1108) are now checked
          -- BEFORE a cutover, against the real securityContext and the real
          -- database, by `health/scripts/check-serving-conditions.sh`. It was
          -- shown to catch #1106 by ablation rather than assumed to.
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
            -- ⚠ `WALK_BUILDING_ESCAPE = "1"` STOOD HERE AND WAS REMOVED
            -- 2026-08-31 (#1268). Its comment said "0" is the emergency
            -- off-switch. That was FALSE: nothing read the variable. The
            -- corrector's flag is a Lean `Flags` field
            -- (`Verified.Geo.WalkAnnotate`) that no request populates and no
            -- shell sets, so "0" would have changed nothing — and an operator
            -- would have discovered that during the emergency.
            --
            -- Deleted rather than wired, deliberately: three sibling flags
            -- (WALK_MATCH_DISABLE, WALK_RECON, WALK_REFINE_DISABLE) are equally
            -- unwired and were never in this manifest, and a switch that has
            -- never been exercised is not safety. The corrector itself is ON,
            -- unconditionally, which is what it has always actually been.
        , probeTiming =
            -- Readiness is the live tree's own 3/10 rather than
            -- `T.standardTiming`'s 5/10: it is behind an Ingress with no
            -- hostPort, so it CAN roll, and a shorter delay is free.
            { readiness = { initialDelaySeconds = 3, periodSeconds = 10 }
            , liveness = Some { initialDelaySeconds = 15, periodSeconds = 20 }
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
          -- route that runs the fold touches it (#1106, measured in production
          -- 2026-08-23).
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
            -- ⚠ The two one-shot Jobs in the live tree (`health-decode-backfill-v7`,
            -- `health-decode-redecode-20260731`) are NOT here and should not be. A
            -- Job's spec is immutable, so re-rendering one with today's flags makes
            -- `apply` fail rather than update; their names encode a run rather than
            -- a service; and `backfill-v7`'s env is a record of how that run
            -- decoded and NOT a policy anything should reproduce. They are spent, and
            -- retiring them is a decision about the cluster, not about the model.
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
                -- ⚠ Verified in three parts, because one of them was vacuous
                -- for a week: the forward pass against production (10 tables
                -- 2026-08-17, `daily_activity` 2026-08-24), the backfill half
                -- by static parity plus a live run that left `sync_state`
                -- BYTE-IDENTICAL, and `migrate()` — absent here on purpose —
                -- which `backend serve` now performs since the HTTP cutover.
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
              , -- Rust+Lean since 2026-08-24 (#982 Tier 2). Verified against
                -- production before the flip: 122 of 128 rows byte-identical,
                -- 128 places, 0 deletions, home_tz unchanged, peak RSS 185Mi
                -- against this job's 512Mi limit.
                --
                -- The three labels that differ are all low-visit clusters in
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
              , -- Rust+Lean since 2026-08-25 (#982 Tier 2). Verified against
                -- production before the flip: 63 of 64 cached routes identical,
                -- ZERO lost, two GAINED (Jubilee-line routes the node arm left
                -- un-snapped), and one differing by two vertices out of 248 —
                -- across a different 21-day window, which makes the agreement a
                -- stronger signal rather than a weaker one. Peak RSS 205Mi.
                --
                -- ⚠ The whole corridor snap runs in Lean (`Verified.Geo.RailSnap`,
                -- 123 guards) via the `railsnap` mode: Rust hands over raw ways,
                -- stations and the pooled fix cloud. The node arm builds the
                -- graph itself and asks Lean only for `dijkstraC`.
                --
                -- ⚠ It REFUSES to report success when every scanned day failed
                -- to compute. Its own first run pooled 0 routes and exited 0 —
                -- #1134's shape — which is how the missing /tmp emptyDir was
                -- found (#1106 had reached only the Deployment).
                command = [ "bin/backend", "refresh-rail-routes" ]
              , -- 90 min. This is where the verified rail search runs in BULK — the
                -- decode's railSnap pass is only an indexed lookup into what this
                -- job filled.
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
              , -- Tier 2 of #982, flipped 2026-08-25 with rail-stops below. The
                -- extraction is Lean and was measured byte-identical to the node
                -- arm on a real 10.5 MB central-London tile: 127 routes, 4088
                -- stops, every stop name in route order and every coordinate to
                -- 7 dp. The PLAN matches too, against the real focus_places —
                -- 65 places, 4 regions, an 18-tile bbox.
                --
                -- ⚠ What a laptop could NOT check is the DB write, which is why
                -- this runs here first: the pod spec and env are where every
                -- failure this week actually lived.
                command = [ "bin/backend", "refresh-bus-routes" ]
              , deadlineSeconds = 5400
              , -- RESUMED 2026-08-14 21:xx, and this time the deploy dependency is
                -- actually met: the running image was built 19:04:25Z from
                -- `1994da1`, which has `8638516` (the per-tile write) as an
                -- ancestor. Checked with `git merge-base --is-ancestor` before
                -- flipping, not assumed.
                --
                -- Why that check and not a smoke test: this was un-suspended
                -- earlier the same day and crashlooped within the hour. The fix
                -- had been verified against the prod DB from a LOCAL build (4 of
                -- 18 tiles lost, mirror 995 -> 1000), but the cluster ran an older
                -- image, so the catch-up run used the OLD count threshold, refused
                -- (`1000 -> 652`) and exited 1. Nothing was damaged — that guard
                -- refuses rather than overwrites — and the lesson is worth keeping
                -- past the fix: verifying against the prod DATABASE says nothing
                -- about what the prod IMAGE will do.
                --
                -- What makes unattended running safe now: a partial run replaces
                -- only the tiles that ANSWERED and leaves every other tile its rows
                -- (`refresh-bus-routes.ts`), so a 504 cannot shrink the mirror.
                -- Overpass 504s are routine, not a fault: runs on 2026-08-14 lost
                -- 1, 6, 4 and 8 of 18 tiles. Under the per-tile write that is a
                -- normal night; under the count threshold it was a refusal.
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
                ,     -- #982 COMPLETE: the sixth and last cron off node, and the
                      -- one #975 was waiting on. Verified 2026-08-26 by decoding
                      -- seven days against the production database with
                      -- `--dry-run` and diffing `decoded_days` as TEXT: 206
                      -- segments, 206 BYTE-IDENTICAL, zero differences.
                      --
                      -- ⚠ NO `--tz`. The Rust arm reads `home_tz` from
                      -- `sync_state` rather than taking it on the command line,
                      -- so the zone cannot drift from what the rest of the
                      -- pipeline uses. That it resolves to Europe/London here is
                      -- not assumed — the byte-identical week is against a node
                      -- arm that was passed `--tz Europe/London` explicitly.
                      --
                      -- ⚠ 7 IS EXPLICIT because node's was. The Rust default is
                      -- 14; leaving it off would quietly double the window.
                      "bin/backend decode-day pippijn 7 && "
                  -- Tier 2 of #982: the rollup is Lean now, and this was the
                  -- first cron step to stop being node. Verified against the
                  -- TypeScript arm on 2026-08-24 by running both against the
                  -- production database and diffing the whole table — 136 rows,
                  -- every column identical.
                  ++  "bin/backend refresh-presence-log 90"
                ]
              , -- 30 min, and the tightest deadline here on purpose: this is the
                -- job an expensive Lean tenant blows first. The matcher's move off
                -- Lean `Int` to `Nat` was forced by a run that missed it.
                --
                -- ⚠ UNCHANGED ACROSS THE RUST FLIP, and measured rather than
                -- hoped: the seven-day run above took 6m03s from a Mac THROUGH
                -- THE SSH TUNNEL, which is an upper bound — half of that wall
                -- clock was IO wait the pod does not pay. 20% of the budget.
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
              , -- Tier 2 of #982, flipped 2026-08-25 with bus-refresh above.
                -- Same measured parity: 188 relations, 3062 stops, identical to
                -- the node arm on a real tile.
                --
                -- ⚠ THIS ARM ALSO GAINED A `tile_key` (3311455), which the node
                -- arm never had. Without it a partial run DELETEd the whole
                -- table and rewrote only what it found — two dry runs the same
                -- afternoon harvested 441 and 313 relations from different
                -- 10-of-18 tile subsets, so consecutive runs would have written
                -- two very different caches and the count going UP (268 -> 441)
                -- would have hidden it. #1134, #1153.
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
                -- On 2026-08-28 `daily_activity` stopped for over an hour because
                -- Fitbit began quoting an integer. `health-sync` exited 0 on every
                -- run; the only trace was one ERROR line in a pod log that nothing
                -- reads. It surfaced because a deploy was being watched for an
                -- unrelated reason — luck, not detection.
                --
                -- ⚠ An error-string watcher would not have caught it and would not
                -- catch the next one: a stream that writes nothing WITHOUT erroring
                -- looks identical from outside. This asks the only question that
                -- generalises, over all eleven streams, and exits NON-ZERO with
                -- their names.
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
