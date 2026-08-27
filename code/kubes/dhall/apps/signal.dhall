-- The `signal` namespace: a Signal archive, and the first model written as a
-- NAMESPACE rather than through the `App` sugar.
--
-- Three workloads share it, which is why `T.App` could never describe it:
--
--   * `signal-db` — MariaDB, the archive's system of record
--   * `signal-cli-rest-api` — the bridge to Signal itself, third-party
--   * `signal-ingester` — a websocket CLIENT that dials the bridge and writes
--     rows; nothing dials IT
--
-- A FOURTH pod lives here and is NOT in this file: the `messages` viewer, whose
-- tree is `kubes/messages/`. It is in this namespace because a `secretKeyRef`
-- cannot cross namespaces and it reads `signal-secret` — so its egress policy
-- is declared HERE, where the namespace's policies live, exactly as the live
-- tree has it.
--
-- ⚠⚠ RENDERED BUT NOT APPLIED. Three deltas remain against the live tree and
-- every one is deliberate:
--
--   1. container names become the workload's (`rest-api` → `signal-cli-rest-api`,
--      `ingester` → `signal-ingester`). Cosmetic; costs a pod restart.
--   2. a liveness probe appears on the bridge, which has readiness only today.
--      Same call health-auth got — a `tcpSocket` check is answered by the
--      kernel's accept queue rather than the process, so a busy pod cannot fail
--      it — but it IS new behaviour on a live pod.
--   3. `netpolDb` adds `signal-db-from-app-only`, admitting 3306 from the whole
--      namespace. The live tree has no such policy: additive hardening, not a
--      change to anything that works.
--
-- ⚠ APPLYING THIS NEEDS `scripts/netpol-reach.sh` RUN FIRST, against
-- `signal/k8s/netpol-reach.table`. The policies below were proved by connecting
-- in #781, and a policy that reads correct and is not is how the archive
-- quietly stops recording.
--
-- ⚠ THE ARCHIVE IS TRANSCRIPTS OF PRIVATE CONVERSATIONS. Every netpol below was
-- measured by connecting (#781, `scripts/netpol-reach.sh` + the
-- `netpol-reach.table` beside it), not reasoned about. Change one and re-run
-- that probe before believing it.
let T = ../lib/types.dhall

let keys =
      { DB_USER = "DB_USER"
      , DB_PASSWORD = "DB_PASSWORD"
      , DB_ROOT_PASSWORD = "DB_ROOT_PASSWORD"
      , SIGNAL_NUMBER = "SIGNAL_NUMBER"
      , -- The nicks whose lines are Pippijn's own. Secret-held rather than
        -- written here because `kubes` is public and the second one is only
        -- explicable as "the nick irssi fell back to on a second connection",
        -- which says as much as the nick itself.
        IRC_SELF_NICK = "IRC_SELF_NICK"
      , IRC_SELF_NICK_ALT = "IRC_SELF_NICK_ALT"
      }

let irclogImport = "signal-irclog-import"

let irclogMount = "/irclogs"

--| Which of irssi's log trees the archive holds.
--
-- ⚠ **THE NETWORKS PIPPIJN STILL HAS TABS OPEN ON**, and that is the rule rather
-- than a list somebody curated. It is the same rule the send path uses — an open
-- window item is what may be sent to — so the two halves cannot disagree about
-- what a live conversation is.
--
-- Measured 2026-08-14: the whole tree is ~89,000 files and 2.3G across twenty
-- tags, and these five are ~36,000 files and ~507M. What the rule leaves out is
-- the point:
--
--   * `freenode` — 25,007 files, 1.4G, and a network nobody has been on for
--     years. Two thirds of the bytes for none of the conversations.
--   * `minbif` — 21,037 files that are not IRC at all: it is an IM gateway, so
--     those are Facebook- and MSN-era contacts bridged through it. Private
--     conversations with a great many named people, and both repositories here
--     are public.
--
-- `xinutec2` is not a network. It is the tag irssi invents for a second
-- simultaneous connection, dead since 2022-01-25, and `--map` folds it back into
-- `xinutec` so the app shows one conversation per person rather than two.
let irclogNetworks = [ "euirc", "libera", "schmorp", "teranova", "xinutec" ]

let sshMount = "/ssh"

--| The ssh key that pulls the logs, as its OWN Secret rather than another entry
--  in `signal-secret`.
--
-- Two lifetimes, not one: this is a credential to a machine in another cluster,
-- rotated when that trust changes, and `signal-secret` holds the database
-- password and the linked-device number. Folding them together would mean
-- rotating an ssh key to change a database password. It is also mounted as
-- FILES, and a volume mounts every key in a secret — putting the DB password on
-- disk in this pod to get at an ssh key beside it.
let irclogSecret = "signal-irclog-sync"

let ircTail = "signal-irc-tail"

--| The tail key's own Secret, for the same two-lifetimes reason as
--  `irclogSecret`: a third credential to the same host, pinned to a third forced
--  command, rotated when that trust changes rather than when a password does.
let tailSecret = ircTail

--| Where the long poll records that it completed a cycle. An `emptyDir`, not a
--  claim: it says only "this process was alive a moment ago", which is worthless
--  across a restart and is exactly what the liveness probe reads.
let heartbeatMount = "/run/irc-tail"

--| amun over the WireGuard tunnel, not `amun.xinutec.org`.
--
-- ⚠ The public name resolves to 94.23.247.133 and routes out of the building
-- and back; the tunnel address is a direct peer (isis 10.100.0.2 ↔ amun
-- 10.100.0.1, measured 2026-08-14). Both work. This one keeps thirteen years of
-- private conversation off the public path even in the seconds it would be
-- inside an ssh session, and it is the address the NetworkPolicy names, so
-- using the other would be blocked anyway.
let amunTunnel = "10.100.0.1"

-- Spelled out rather than folded from `irclogNetworks`: there is no Prelude
-- import here, and a hand-rolled fold would be more machinery than six names
-- deserve. That list is the statement of the rule; these two are its
-- consequences, and `generate.sh --check` is what keeps them level.
--
-- Each source names the host again rather than using rsync's `host:a :b` short
-- form, which works and reads like a typo.
let irclogSources =
      "irssi@${amunTunnel}:xinutec irssi@${amunTunnel}:xinutec2 irssi@${amunTunnel}:euirc irssi@${amunTunnel}:libera irssi@${amunTunnel}:schmorp irssi@${amunTunnel}:teranova"

let irclogNetworkArgs =
      "--network xinutec --network xinutec2 --network euirc --network libera --network schmorp --network teranova"

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let lit = T.EnvValue.Literal

let restApiName = "signal-cli-rest-api"

let restApiPort = 8080

-- The claims this namespace owns. In their own file because `kubes/messages`
-- mounts one of them — see `signal-claims.dhall`.
let claims = ../signal-claims.dhall

in  { name = "signal"
    , -- This tree creates the namespace — including the one `messages` runs in.
      -- See `T.Owner`, and `messages.dhall`'s `Elsewhere` pointing back here.
      owner = T.Owner.Own
    , labels = [] : T.Labels
    , unowned = [] : List T.Unowned
    , placement = T.on T.Cluster.isis
    , db = Some
      { dbName = "signal"
      , -- ⚠ MEASURED 2026-08-14, and the default 128 MiB stopped being tenable
        -- the day IRC ingestion opened to five networks: `irc_messages` went to
        -- 3.7M rows, 502 MiB of data and 289 MiB of index, so a search scanned
        -- the whole table through a pool a fifth its size and did ~43,000
        -- physical page reads every time. With 1 GiB the table is resident and
        -- the same search is **4.1s against 10.0s**.
        --
        -- 1 GiB rather than 2: it covers data + index with room, and this box
        -- also runs the rest of the fleet. What it does NOT help is the
        -- conversation list — 1.5s before and after, because that one is
        -- answered from the index alone and is CPU-bound, not I/O-bound. Only
        -- the queries that touch row data gain.
        --
        -- ⚠ The first query after a restart is still slow (27.7s measured) —
        -- the pool starts empty and that scan is what fills it.
        innodbBufferPoolGi = Some 1
      , -- Text messages are small; 10Gi covers years plus the history backfill.
        storageGi = 10
      , resources =
        { requests =
          { cpu = "50m"
          , -- 1 GiB pool + mariadbd overhead, the two moving together exactly as
            -- health-db's do.
            memory = "1280Mi"
          }
        , limits = None T.Limits
        }
      , keys =
        { user = keys.DB_USER
        , password = keys.DB_PASSWORD
        , rootPassword = keys.DB_ROOT_PASSWORD
        }
      }
    , configMap = None T.ConfigMapDoc
    , claims = [ claims.cli, claims.attachments, claims.irclogs ]
    , workloads =
      [ { name = restApiName
        , -- A ClusterIP the ingester and the viewer resolve. Not `NoService`:
          -- this one genuinely is dialled, in-cluster, by name.
          reach = T.Reach.Internal
        , image =
            T.Image.Upstream
              { repo = "bbernhard/signal-cli-rest-api", tag = "0.100" }
        , command = None (List Text)
        , port = restApiPort
        , uid = 1000
        , -- ⚠ CANNOT BE FORCED NON-ROOT, and this was measured rather than
          -- assumed. See `T.Hardening`.
          hardening =
            T.Hardening.Unhardened
              { why =
                  "entrypoint runs usermod/groupmod as root before dropping to uid 1000; runAsNonRoot fails them with 'cannot lock /etc/group' and crash-loops the container"
              }
        , rootFs =
            T.RootFs.Writable
              { why =
                  "third-party JVM image: it writes its own data dir and whatever the runtime wants, and that filesystem is not ours to constrain"
              }
        , env = [ { name = "MODE", value = lit "json-rpc" } ]
        , readiness = None T.Readiness
        , probeTiming =
            { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
            , liveness = { initialDelaySeconds = 15, periodSeconds = 20 }
            }
        , -- `Tcp`: the bridge has no health endpoint, and this is honest about
          -- what is actually checked.
          probe = T.Probe.Tcp { port = restApiPort }
        , resources =
          { requests = { cpu = "100m", memory = "384Mi" }
          , -- No limit, and dev-lint's image_profile is why this is allowed to
            -- say so: what a third-party JVM image needs is not ours to cap.
            limits = None T.Limits
          }
        , volumes = [ { name = "data", source = T.VolumeSource.Claim claims.cli } ]
        , mounts =
          [ { name = "data"
            , mountPath = "/home/.local/share/signal-cli"
            , subPath = None Text
            , readOnly = False
            }
          ]
        , tasks = [] : List T.ScheduledTask
        }
      , { name = "signal-ingester"
        , -- ⚠ NOTHING DIALS THIS. It is a websocket client: it connects OUT to
          -- the bridge and writes rows, and listens on no port. `Internal`
          -- would give it a Service with no consumers, which reads to a
          -- reviewer as an integration point that exists.
          reach = T.Reach.NoService
        , image = T.Image.Fleet "signal-archiver"
        , command = None (List Text)
        , -- Not reachable, so this number names nothing outside the pod. It is
          -- required by `T.Workload` and the bridge's port is the honest value
          -- to carry.
          port = restApiPort
        , uid = 65532
        , hardening = T.Hardening.NonRoot
        , rootFs =
            T.RootFs.Writable
              { why =
                  "writes downloaded blobs under /attachments (a mount) and uses /tmp scratch"
              }
        , env =
          [ { name = "DB_HOST", value = lit "signal-db" }
          , { name = "DB_NAME", value = lit "signal" }
          , { name = "SIGNAL_API_WS"
            , value = lit "ws://${restApiName}:${Natural/show restApiPort}"
            }
          , { name = "SIGNAL_API_HTTP"
            , value = lit "http://${restApiName}:${Natural/show restApiPort}"
            }
          , { name = "ATTACHMENTS_DIR", value = lit "/attachments" }
          , { name = "DB_USER", value = secret keys.DB_USER }
          , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
          , { name = "SIGNAL_NUMBER", value = secret keys.SIGNAL_NUMBER }
          ]
        , readiness = None T.Readiness
        , probeTiming = T.standardTiming
        , -- ⚠ INERT under `Unprobed` — see the note at `T.Probe`.
          probe = T.Probe.Unprobed
        , resources =
          { requests = { cpu = "50m", memory = "64Mi" }
          , -- ⚠ THIS LIMIT ONLY BECAME MEANINGFUL ON 2026-08-17, and the order
            -- matters. It carried none because `download_attachment` did
            -- `resp.bytes().await` — the whole blob resident before the write —
            -- so peak memory was the largest thing anybody sent, which this pod
            -- does not choose. A cap set from the 5Mi steady state would have
            -- been a cap on somebody else's video, and the OOM-kill would have
            -- read as an unexplained crash-loop. The binary now streams the body
            -- chunk by chunk (`attach::write_stream`), so resident size is one
            -- chunk and 128Mi is a real ceiling: ~20x the measured 5Mi, and a
            -- kill at it means a leak rather than a big attachment.
            --
            -- No cpu limit: a throttle here would stall an ingest nobody is
            -- waiting on, and show up as latency nobody can attribute.
            limits = Some { cpu = None Text, memory = "128Mi" }
          }
        , volumes =
          [ { name = "attachments"
            , source = T.VolumeSource.Claim claims.attachments
            }
          ]
        , mounts =
          [ { name = "attachments"
            , mountPath = "/attachments"
            , subPath = None Text
            , readOnly = False
            }
          ]
        , tasks =
          [ { name = irclogImport
            , -- ⚠ EVERY FIFTEEN MINUTES, AND THIS IS NOT A LATENCY NUMBER.
              -- `ircTail` below is the live tier and writes each line in under a
              -- second on the same dedupe key; this task is its RECONCILER, so
              -- what the cadence sets is how fast a line the tail DROPPED is
              -- recovered, not how fresh the archive is. The comment here used to
              -- say the long-poll tier "is not needed" — it was built, it runs,
              -- and that sentence has been wrong since.
              --
              -- ⚠ IT WAS EVERY MINUTE, AND THAT COST THE HEALTH BACKUP 41%.
              -- Ablated 2026-08-24 (import off 335s, on 473s, back to back on an
              -- idle disk) and corroborated observationally 2026-08-26 by a 15s
              -- sampler across the real backup window: of the sixteen D-state
              -- blocking occurrences during the health dump, TEN were this
              -- importer and two were rsync — and it was in D state ONLY inside
              -- that window, never once in the other 59 minutes. The live dump
              -- took 969s, twice the ablation's loaded arm. At `*/15` its share
              -- of the window falls from ~40% to ~3%.
              --
              -- Hourly was the ORIGINAL setting and was never a latency
              -- judgement: it was the price of a run that cost the same whatever
              -- had happened. MEASURED 2026-08-14: the importer re-read all
              -- 36,201 staged files and re-issued `INSERT IGNORE` for all 3.68M
              -- lines every time, taking 10m34s to write 14 rows. `signal`'s
              -- `irc_import_state` made a run cost what ARRIVED — 20 seconds end
              -- to end, zero files opened — which is what makes the cadence free
              -- to choose on other grounds, as it now is.
              --
              -- ⚠ Safe to overlap-proof rather than by luck: `concurrencyPolicy`
              -- is `Forbid` for every task in this model (see `render.dhall`), so
              -- a run that ever outlasts its window delays the next rather than
              -- racing it into the same rows.
              schedule = "*/15 * * * *"
            , -- ⚠ TWO STEPS, so a shell. The logs are on the OTHER CLUSTER —
              -- irssi runs in `vps-pippijn` on amun — so they are pulled over
              -- ssh into `${irclogMount}` and imported from there. The far side
              -- pins this key to `irclog-pull`, so what this command can do
              -- there is read that one directory and nothing else.
              --
              -- NOT `rrsync`, which is what a `command=` for this should be and
              -- is what this said until the send path was built: it is a python3
              -- script in an image with no python3, so a key pinned to it is
              -- inert rather than restricted.
              --
              -- ⚠ NO `--delete`, and not as an oversight. irssi's autolog only
              -- ever appends, so there is nothing upstream to mirror away; and
              -- `--delete` with two sources into one destination is a documented
              -- way to remove files that the other source put there. A stale
              -- file costs one re-read of rows the importer already has.
              --
              -- `--map` folds irssi's second-connection tag into one network,
              -- and `--self-nick` is how a line is known to be Pippijn's; both
              -- are arguments rather than constants because this repository is
              -- public and a nick is not a thing to commit.
              command =
              [ "/bin/sh"
              , "-c"
              , "install -m 400 ${sshMount}/id_ed25519 /tmp/key && rsync -a -e 'ssh -i /tmp/key -o UserKnownHostsFile=${sshMount}/known_hosts -o StrictHostKeyChecking=yes -p 2230' ${irclogSources} ${irclogMount}/ && import_irclogs --root ${irclogMount} ${irclogNetworkArgs} --map xinutec2=xinutec --self-nick \"\$IRC_SELF_NICK\" --self-nick \"\$IRC_SELF_NICK_ALT\" --apply"
              ]
            , -- 45 min. A first run walks every file in six trees and transfers
              -- ~507M; every later one transfers almost nothing and the import
              -- is dedupe misses only. Raised from 20 when the scope went from
              -- one network to the five with open tabs — 11,885 files to
              -- ~36,000 — because a deadline that fits the steady state and not
              -- the first run fails exactly once, on the run that matters, and
              -- leaves a half-imported archive to explain.
              deadlineSeconds = 2700
            , suspended = False
            , -- ⚠ ITS OWN reason, not the ingester's. This runs under that
              -- workload but does something else entirely: `install -m 400
              -- ${sshMount}/id_ed25519 /tmp/key`, the same secret-volume story
              -- as irc-tail's, and nothing to do with /attachments.
              rootFs =
                T.RootFs.Writable
                  { why =
                      "copies the ssh key to /tmp at 0400 before rsync, because a secret volume is root-owned"
                  }
            , env =
              [ { name = "DB_HOST", value = lit "signal-db" }
              , { name = "DB_NAME", value = lit "signal" }
              , { name = "DB_USER", value = secret keys.DB_USER }
              , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
              , { name = "IRC_SELF_NICK", value = secret keys.IRC_SELF_NICK }
              , { name = "IRC_SELF_NICK_ALT"
                , value = secret keys.IRC_SELF_NICK_ALT
                }
              ]
            , volumes =
              [ { name = "irclogs", source = T.VolumeSource.Claim claims.irclogs }
              , { name = "sshkey"
                , source =
                    T.VolumeSource.Secret
                      { name = irclogSecret
                      , -- ⚠ 0444, NOT 0400, and the command copies the key to
                        -- /tmp at 0400 before using it. A secret volume's files
                        -- are owned by **root** — not by `runAsUser` — so 0400
                        -- means this pod cannot read its own secret. It does
                        -- not fail as a permissions error either: an unreadable
                        -- `known_hosts` reads to ssh as "no host key known for
                        -- [10.100.0.1]:2230", which is where an hour went.
                        --
                        -- The copy is still needed at any mode, because ssh
                        -- refuses a key with any group or other bit set. The
                        -- tighter alternative is 0440 plus `fsGroup`, which
                        -- `T.ScheduledTask` cannot currently express.
                        mode = Some T.fileMode.anyoneRead
                      }
                }
              ]
            , mounts =
              [ { name = "irclogs"
                , mountPath = irclogMount
                , subPath = None Text
                , readOnly = False
                }
              , { name = "sshkey"
                , mountPath = sshMount
                , subPath = None Text
                , readOnly = True
                }
              ]
            , resources =
              { requests = { cpu = "50m", memory = "128Mi" }
              , limits = Some { cpu = Some "1", memory = "512Mi" }
              }
            }
          ]
        }
      , { name = ircTail
        , -- ⚠ NOTHING DIALS THIS EITHER, for the same reason as the ingester: it
          -- connects OUT and holds a long poll open.
          reach = T.Reach.NoService
        , image = T.Image.Fleet "signal-archiver"
        , -- ⚠ THE LIVE TIER, and the CronJob above is its reconciler. This holds
          -- one request open to irssi's plugin, which answers with the lines it
          -- has just logged AND WHERE THEY ARE — so the row written here is the
          -- row the next import would write, on the same dedupe key. A line
          -- reaches the archive in under a second instead of within the minute.
          --
          -- Why this exists at all, when the import already collects everything:
          -- SENDING was always synchronous, so one conversation had two
          -- architectures — sub-second out, up to a minute back. Now both
          -- directions are the same shape.
          --
          -- ⚠ WHAT MAKES IT SAFE TO BE THE SIMPLE ONE is that the reconciler is
          -- still running. A missed line here is LATE, not lost.
          command = Some
          [ "/usr/local/bin/irc_tail"
          , "--host"
          , amunTunnel
          , "--port"
          , "2230"
          , "--key"
          , "${sshMount}/id_ed25519"
          , "--known-hosts"
          , "${sshMount}/known_hosts"
          , "--map"
          , "xinutec2=xinutec"
          , "--heartbeat"
          , "${heartbeatMount}/alive"
          ]
        , -- Not reachable; required by `T.Workload`, and the port it polls is
          -- the honest value to carry.
          port = 2230
        , uid = 65532
        , hardening = T.Hardening.NonRoot
        , rootFs =
            T.RootFs.Writable
              { why =
                  "copies the ssh key to /tmp at 0400 before use, for the reason the CronJob's `sshkey` note gives: a secret volume is root-owned"
              }
        , env =
          [ { name = "DB_HOST", value = lit "signal-db" }
          , { name = "DB_NAME", value = lit "signal" }
          , { name = "DB_USER", value = secret keys.DB_USER }
          , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
          , -- ⚠ WITHOUT THESE EVERY LINE IS SOMEBODY ELSE'S, INCLUDING HIS OWN,
            -- and this shipped without them. The first message the live tier
            -- pushed was Pippijn's and the app drew it as another person's —
            -- silently, because `is_self` has no wrong value, only a wrong one.
            --
            -- The binary now refuses to start without `IRC_SELF_NICK`, so the
            -- next omission is a CrashLoopBackOff rather than a conversation
            -- attributed to a stranger. Read from the environment rather than
            -- passed as arguments because, unlike the importer, this needs no
            -- shell and adding one to expand a variable is machinery for its
            -- own sake.
            { name = "IRC_SELF_NICK", value = secret keys.IRC_SELF_NICK }
          , { name = "IRC_SELF_NICK_ALT"
            , value = secret keys.IRC_SELF_NICK_ALT
            }
          ]
        , readiness = None T.Readiness
        , probeTiming = T.standardTiming
        , -- ⚠ THE POINT OF THE HEARTBEAT, and the reason this is not
          -- `Unprobed` like the ingester. A long poll that has stopped asking
          -- looks EXACTLY like a channel where nobody is talking, and the
          -- reconciler would go on backfilling within the minute — so the system
          -- would be broken and indistinguishable from healthy. The binary
          -- touches this file every completed cycle INCLUDING the empty ones,
          -- and deliberately not after a failed one; five minutes is generous
          -- against the plugin's two-minute park.
          --
          -- Rendered as both readiness and liveness, so a stale file does not
          -- warn — it restarts the pod.
          probe = T.Probe.Exec
            { command =
              [ "/bin/sh"
              , "-c"
              , "test -n \"\$(find ${heartbeatMount}/alive -mmin -5 2>/dev/null)\""
              ]
            }
        , resources =
          { requests = { cpu = "50m", memory = "64Mi" }
          , -- Bounded BY CONSTRUCTION, unlike the ingester's was: the irssi
            -- plugin answers a poll from a 256-line ring and this holds one
            -- reply at a time, so there is no input size it does not control.
            -- Measured on isis 2026-08-17 at 6Mi; 128Mi is ~20x that, so a kill
            -- here means something is wrong rather than something is large.
            limits = Some { cpu = None Text, memory = "128Mi" }
          }
        , volumes =
          [ { name = "sshkey"
            , source =
                T.VolumeSource.Secret
                  { name = tailSecret
                  , -- 0444 for the reason the CronJob's copy of this note gives.
                    mode = Some T.fileMode.anyoneRead
                  }
            }
          , { name = "heartbeat", source = T.VolumeSource.EmptyDir }
          ]
        , mounts =
          [ { name = "sshkey"
            , mountPath = sshMount
            , subPath = None Text
            , readOnly = True
            }
          , { name = "heartbeat"
            , mountPath = heartbeatMount
            , subPath = None Text
            , readOnly = False
            }
          ]
        , -- The reconciler is a task of the INGESTER above, not of this. They
          -- run the same image, but a scheduled task shares its workload's uid
          -- and root-filesystem posture, and hanging the import off the live
          -- tier would say the two depend on each other. They deliberately do
          -- not: the import is what still works when this is down.
          tasks = [] : List T.ScheduledTask
        }      ]
    , secrets = toMap keys
    , netpol =
        T.Netpol.Policies
          [ { name = "default-deny-egress"
            , target = T.NetpolTarget.WholeNamespace
            , egress =
              [ { to = [ T.NetpolPeer.Namespace "kube-system" ]
                , -- DNS needs BOTH, and the API defaults to TCP, so UDP cannot
                  -- be left implicit.
                  ports =
                  [ { port = 53, protocol = "UDP" }
                  , { port = 53, protocol = "TCP" }
                  ]
                }
              , { -- Everything in this namespace may reach the database and the
                  -- bridge. Stated as SameNamespace rather than two named
                  -- workloads so a pod added later is covered rather than
                  -- silently cut off — which is the failure mode that would
                  -- appear as an archive quietly falling behind.
                  to = [ T.NetpolPeer.SameNamespace ]
                , ports =
                  [ { port = 3306, protocol = "TCP" }
                  , { port = restApiPort, protocol = "TCP" }
                  ]
                }
              ]
            }
          , { -- The bridge, and ONLY the bridge, may reach the public internet:
              -- it has to talk to Signal's servers. The private ranges are
              -- excluded so this cannot become a path back into the house.
              -- The live object's name, stated rather than derived: renaming a
              -- NetworkPolicy means creating a new one and orphaning the old.
              name = "signal-cli-egress-internet"
            , target = T.NetpolTarget.OneWorkload restApiName
            , egress =
              [ { to =
                  [ T.NetpolPeer.Internet
                      { except =
                        [ "10.0.0.0/8"
                        , "172.16.0.0/12"
                        , "192.168.0.0/16"
                        , "169.254.0.0/16"
                        , "127.0.0.0/8"
                        ]
                      }
                  ]
                , ports = [ { port = 443, protocol = "TCP" } ]
                }
              ]
            }
          , { -- The IRC importer, and ONLY it, may reach amun's sshd. That is
              -- the whole of its outside world: one address, one port, and the
              -- key it presents is pinned to `irclog-pull` on the far side, so
              -- the reach this grants is "read one directory".
              --
              -- ⚠ This is why a CronJob's pods carry labels — see `K.JobSpec`.
              -- Without them the only expressible rule would be namespace-wide,
              -- which would hand the same reach to the bridge, the viewer and
              -- the database, none of which have any business on that host.
              name = "${irclogImport}-egress-amun"
            , target = T.NetpolTarget.OneWorkload irclogImport
            , egress =
              [ { to =
                  [ T.NetpolPeer.Host
                      { cidr = "${amunTunnel}/32"
                      , why =
                          "amun over WireGuard: irssi's autologs live in vps-pippijn on that cluster and cannot be mounted from this one"
                      }
                  ]
                , ports = [ { port = 2230, protocol = "TCP" } ]
                }
              ]
            }
          , { -- The `messages` viewer's SSO callback, declared here because
              -- this is the namespace that owns the policies even though the
              -- workload's tree is `kubes/messages/`.
              --
              -- ⚠ It reaches the ingress controller by the SVCLB POD, not by
              -- the node address. #781 measured an `ipBlock` naming isis's
              -- public IP matching nothing: CNI-HOSTPORT-DNAT rewrites the
              -- destination before kube-router's filter rules ever see it.
              name = "${ircTail}-egress-amun"
            , target = T.NetpolTarget.OneWorkload ircTail
            , egress =
              [ { to =
                  [ T.NetpolPeer.Host
                      { cidr = "${amunTunnel}/32"
                      , why =
                          "amun over WireGuard: the long poll asks irssi what it has just logged, and irssi lives in vps-pippijn on that cluster"
                      }
                  ]
                , ports = [ { port = 2230, protocol = "TCP" } ]
                }
              ]
            }
          , { -- ⚠ THREE RULES NOW NAME THE SAME ADDRESS AND PORT, and that is
              -- the honest shape rather than a redundancy to fold away. A
              -- NetworkPolicy's vocabulary stops at "may open 2230"; what
              -- separates these three is the KEY each pod presents, and each is
              -- pinned to a different forced command on the far side —
              -- `irclog-pull` reads the log tree, `irc-send` speaks, `irc-tail`
              -- listens. Merging them into one namespace-wide rule would hand
              -- every pod here the union of three capabilities it cannot
              -- exercise but should not be granted.
              name = "messages-egress-sso"
            , target = T.NetpolTarget.OneWorkload "messages"
            , egress =
              [ { to =
                  [ T.NetpolPeer.NamespacedWorkload
                      { namespace = "kube-system"
                      , labels =
                          toMap
                            { `svccontroller.k3s.cattle.io/svcname` =
                                "ingress-nginx-controller"
                            , `svccontroller.k3s.cattle.io/svcnamespace` =
                                "ingress-nginx"
                            }
                      }
                  ]
                , ports = [ { port = 443, protocol = "TCP" } ]
                }
              ]
            }
          , { -- The viewer may reach amun's sshd too, and for the opposite
              -- reason to the importer: to SEND. This is the only egress in the
              -- namespace that exists so something can leave rather than arrive.
              --
              -- ⚠ SAME ADDRESS AND PORT AS THE IMPORTER'S RULE, DIFFERENT KEY,
              -- AND THAT IS WHERE THE LIMIT LIVES. A network policy cannot say
              -- "may send an IRC message"; it can only say "may open 2230". What
              -- makes this narrow is the far side: the key this pod presents is
              -- pinned to `command="/home/irssi/bin/irc-send",restrict`, which
              -- copies one line to a unix socket and one line back. The
              -- importer's key on the same port is pinned to `irclog-pull` and
              -- can only read. Neither can do the other's job, and neither can
              -- get a shell.
              name = "messages-egress-irssi"
            , target = T.NetpolTarget.OneWorkload "messages"
            , egress =
              [ { to =
                  [ T.NetpolPeer.Host
                      { cidr = "${amunTunnel}/32"
                      , why =
                          "amun over WireGuard: irssi holds the IRC connections and lives in vps-pippijn on that cluster, so sending as Pippijn means reaching that host"
                      }
                  ]
                , ports = [ { port = 2230, protocol = "TCP" } ]
                }
              ]
            }
          ]
    }
    : T.Namespace
