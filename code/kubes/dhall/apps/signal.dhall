let T =
      -- The `signal` namespace: a Signal archive, and the first model written as a
      -- NAMESPACE rather than through the `App` sugar.
      --
      -- Several workloads share it, which is why `T.App` cannot describe it:
      --
      --   * `signal-db` — MariaDB, the archive's system of record
      --   * `signal-cli-rest-api` — the bridge to Signal itself, third-party
      --   * `signal-ingester` — a websocket CLIENT that dials the bridge and writes
      --     rows; nothing dials IT
      --   * `signal-irc-tail` — the live IRC tier, a long poll out to irssi
      --   * `signal-telegram` — the Telegram feed, history and live in one session
      --
      -- A fourth pod lives here and is NOT in this file: the `messages` viewer, in
      -- `kubes/messages/`. It is in this namespace because a `secretKeyRef` cannot
      -- cross namespaces, so its egress policy is declared here with the rest.
      --
      -- ⚠ CHANGE A NETPOL BELOW AND RE-RUN `scripts/netpol-reach.sh` against
      -- `signal/k8s/netpol-reach.table` before believing it (#781). The archive is
      -- transcripts of private conversations, and a policy that reads correct and is
      -- not is how it quietly stops recording.
      ../lib/types.dhall

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
      , -- Pippijn's own Telegram application credentials, from
        -- <https://my.telegram.org>. Secret-held rather than written here for the
        -- ordinary reason — `kubes` is public — and they are not interchangeable
        -- with the SESSION: these identify the application, while the session in
        -- `telegram_session` identifies the account and is the one that costs a
        -- flood wait to replace.
        TELEGRAM_API_ID = "TELEGRAM_API_ID"
      , TELEGRAM_API_HASH = "TELEGRAM_API_HASH"
      }

let irclogImport = "signal-irclog-import"

let irclogMount = "/irclogs"

let irclogNetworks =
      --| Which of irssi's log trees the archive holds.
      --
      -- ⚠ **THE NETWORKS PIPPIJN STILL HAS TABS OPEN ON**, and that is the rule rather
      -- than a list somebody curated. It is the same rule the send path uses — an open
      -- window item is what may be sent to — so the two halves cannot disagree about
      -- what a live conversation is.
      --
      -- These five are a small part of the tree, and what the rule leaves out is the
      -- point:
      --
      --   * `freenode` — most of the bytes, and a network nobody has been on for
      --     years. No conversations to go with them.
      --   * `minbif` — not IRC at all: it is an IM gateway, so those are Facebook-
      --     and MSN-era contacts bridged through it. Private conversations with a
      --     great many named people, and both repositories here are public.
      --
      -- `xinutec2` is not a network. It is the tag irssi invents for a second
      -- simultaneous connection, long dead, and `--map` folds it back into
      -- `xinutec` so the app shows one conversation per person rather than two.
      [ "euirc", "libera", "schmorp", "teranova", "xinutec" ]

let sshMount = "/ssh"

let irclogSecret =
      --| The ssh key that pulls the logs, as its OWN Secret rather than another entry
      --  in `signal-secret`.
      --
      -- Two lifetimes, not one: this is a credential to a machine in another cluster,
      -- rotated when that trust changes, and `signal-secret` holds the database
      -- password and the linked-device number. Folding them together would mean
      -- rotating an ssh key to change a database password. It is also mounted as
      -- FILES, and a volume mounts every key in a secret — putting the DB password on
      -- disk in this pod to get at an ssh key beside it.
      "signal-irclog-sync"

let ircTail = "signal-irc-tail"

let telegram = "signal-telegram"

let telegramMediaMount =
      --| Where fetched Telegram media lands. The same path in the viewer, read-only,
      --  so a stored file NAME means the same thing in both pods — which is what lets
      --  the database hold names rather than paths.
      "/telegram-media"

let tailSecret =
      --| The tail key's own Secret, for the same two-lifetimes reason as
      --  `irclogSecret`: a third credential to the same host, pinned to a third forced
      --  command, rotated when that trust changes rather than when a password does.
      ircTail

let heartbeatMount =
      --| Where the long poll records that it completed a cycle. An `emptyDir`, not a
      --  claim: it says only "this process was alive a moment ago", which is worthless
      --  across a restart and is exactly what the liveness probe reads.
      "/run/irc-tail"

let amunTunnel =
      --| amun over the WireGuard tunnel, not `amun.xinutec.org`.
      --
      -- ⚠ The public name resolves to 94.23.247.133 and routes out of the building
      -- and back; the tunnel address is a direct peer (isis 10.100.0.2 ↔ amun
      -- 10.100.0.1). Both work. This one keeps thirteen years of
      -- private conversation off the public path even in the seconds it would be
      -- inside an ssh session, and it is the address the NetworkPolicy names, so
      -- using the other would be blocked anyway.
      "10.100.0.1"

let isisFrontDoor =
      --| isis's own public address, which is what `dash.xinutec.org` resolves to.
      --
      -- ⚠ Not the tunnel address, and that is forced rather than chosen: the pod
      -- resolves the name through cluster DNS and gets this one, so this is the
      -- destination kube-router filters on. Naming 10.100.0.2 would read as the
      -- safer choice and match nothing. The packet never reaches the wire either
      -- way — the address is LOCAL on this node, so it is routed in the kernel.
      "188.165.200.180"

let irclogSources =
      -- Spelled out rather than folded from `irclogNetworks`: there is no Prelude
      -- import here, and a hand-rolled fold would be more machinery than six names
      -- deserve. That list is the statement of the rule; these two are its
      -- consequences, and `generate.sh --check` is what keeps them level.
      --
      -- Each source names the host again rather than using rsync's `host:a :b` short
      -- form, which works and reads like a typo.
      "irssi@${amunTunnel}:xinutec irssi@${amunTunnel}:xinutec2 irssi@${amunTunnel}:euirc irssi@${amunTunnel}:libera irssi@${amunTunnel}:schmorp irssi@${amunTunnel}:teranova"

let irclogNetworkArgs =
      "--network xinutec --network xinutec2 --network euirc --network libera --network schmorp --network teranova"

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let lit = T.EnvValue.Literal

let restApiName = "signal-cli-rest-api"

let restApiPort = 8080

let claims =
      -- The claims this namespace owns. In their own file because `kubes/messages`
      -- mounts one of them — see `signal-claims.dhall`.
      ../signal-claims.dhall

in  { name = "signal"
    , -- This tree creates the namespace — including the one `messages` runs in.
      -- See `T.Owner`, and `messages.dhall`'s `Elsewhere` pointing back here.
      owner = T.Owner.Own
    , labels = [] : T.Labels
    , unowned = [] : List T.Unowned
    , acme = None T.AcmeDelegation
    , tree = None Text
    , placement = T.on T.Cluster.isis
    , db = Some
      { dbName = "signal"
      , -- ⚠ SIZED TO HOLD `irc_messages` DATA + INDEX RESIDENT. IRC ingestion
        -- across five networks takes it to millions of rows, and a pool smaller
        -- than the table turns every search into a full scan of physical page
        -- reads. 1 GiB rather than 2 because this box also runs the rest of the
        -- fleet.
        --
        -- It does NOT help the conversation list, which is answered from the
        -- index alone and is CPU-bound. Only queries touching row data gain.
        --
        -- ⚠ The first query after a restart is still slow — the pool starts
        -- empty and that scan is what fills it.
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
    , claims =
      [ claims.cli, claims.attachments, claims.irclogs, claims.telegramMedia ]
    , workloads =
      [ T.Workload::{ name = restApiName
        , -- A ClusterIP the ingester and the viewer resolve. Not `NoService`:
          -- this one genuinely is dialled, in-cluster, by name.
          reach = T.Reach.Internal
        , image =
            T.Image.Upstream
              { repo = "bbernhard/signal-cli-rest-api", tag = "0.100" }
        , port = restApiPort
        , uid = 1000
        , selector = T.Selector.App
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
        , probeTiming =
            { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
            , liveness = Some { initialDelaySeconds = 15, periodSeconds = 20 }
            }
        , -- `Tcp`: the bridge has no health endpoint, and this is honest about
          -- what is actually checked.
          probe = T.Probe.Tcp { port = restApiPort }
        , resources =  Some
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
        }
      , T.Workload::{ name = "signal-ingester"
        , -- ⚠ NOTHING DIALS THIS. It is a websocket client: it connects OUT to
          -- the bridge and writes rows, and listens on no port. `Internal`
          -- would give it a Service with no consumers, which reads to a
          -- reviewer as an integration point that exists.
          reach = T.Reach.NoService
        , image = T.Image.Fleet "signal-archiver"
        , -- ⚠ **THE IMAGE'S OWN ENTRYPOINT, STATED, and it is not redundant.** One
          -- image holds four programs, and a container that names none of them says
          -- only "some of signal-archiver runs here" — which is how this one came to
          -- be reported as owing `TELEGRAM_API_ID`, a credential it has no business
          -- holding. dev-lint reads `command` to know which binary's environment a
          -- container is answerable for, so an unstated entrypoint makes it
          -- answerable for ALL FOUR, and the suggested cure would have handed the
          -- Signal ingester Pippijn's Telegram keys. Changes nothing at runtime.
          command = Some [ "/usr/local/bin/signal-archiver" ]
        , -- Not reachable, so this number names nothing outside the pod. It is
          -- required by `T.Workload` and the bridge's port is the honest value
          -- to carry.
          port = restApiPort
        , uid = 65532
        , selector = T.Selector.App
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
        , probeTiming = T.standardTiming
        , -- ⚠ INERT under `Unprobed` — see the note at `T.Probe`.
          probe = T.Probe.Unprobed
        , resources =  Some
          { requests = { cpu = "50m", memory = "64Mi" }
          , -- ⚠ THIS LIMIT DEPENDS ON THE DOWNLOAD STREAMING. `attach::write_stream`
            -- writes the body chunk by chunk, so resident size is one chunk and
            -- 128Mi is a real ceiling — a kill at it means a leak rather than a
            -- big attachment. Hold the whole blob in memory instead and peak is
            -- the largest thing anybody sent, which this pod does not choose: the
            -- cap becomes a cap on somebody else's video and the OOM-kill reads
            -- as an unexplained crash-loop.
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
              -- recovered, not how fresh the archive is.
              --
              -- ⚠ NOT EVERY MINUTE: this is IO-heavy and it overlaps the health
              -- dump, where it was measured doing most of the D-state blocking.
              -- At `*/15` its share of that window is a few percent.
              --
              -- The cadence is free to choose at all only because
              -- `irc_import_state` makes a run cost what ARRIVED. Without it a
              -- run re-reads every staged file and re-issues `INSERT IGNORE` for
              -- every line, costing the same whatever happened.
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
      , T.Workload::{ name = ircTail
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
        , selector = T.Selector.App
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
        , resources =  Some
          { requests = { cpu = "50m", memory = "64Mi" }
          , -- Bounded BY CONSTRUCTION, unlike the ingester's was: the irssi
            -- plugin answers a poll from a 256-line ring and this holds one
            -- reply at a time, so there is no input size it does not control.
            -- 128Mi is far above its steady state, so a kill here means something
            -- is wrong rather than something is large.
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
        }
      , T.Workload::{ name = telegram
        , -- ⚠ NOTHING DIALS THIS, like the other two feeds: it speaks MTProto
          -- OUTWARD to Telegram and writes rows.
          reach = T.Reach.NoService
        , image = T.Image.Fleet "signal-archiver"
        , -- ⚠ **BOTH FEEDS IN ONE PROCESS, which is why there is one workload and
          -- not two.** Telegram keeps history server-side, so the same authorised
          -- session pages backwards through a decade AND holds the live update
          -- stream — and they MUST share it: two pods would be two sessions, each
          -- acknowledging update state the other needs, which is how an archive
          -- develops a gap that nothing reports. The binary runs them as
          -- concurrent tasks for the reason irc-tail exists beside its importer: a
          -- message arriving now must not wait on 2019.
          --
          -- ⚠ THE FIRST RUN NEEDS A HUMAN, once per account lifetime. Telegram
          -- sends a code to the phone, so `telegram login` is interactive, and this
          -- pod refuses to start until a session exists rather than retrying
          -- forever — a feed that is quietly not logged in looks exactly like a
          -- quiet week. See the `signal` repo's README for the one-off command.
          command = Some [ "/usr/local/bin/telegram" ]
        , -- Not reachable; required by `T.Workload`. 443 is the port MTProto
          -- actually leaves on, so it is the honest value to carry.
          port = 443
        , uid = 65532
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- ⚠ READ-ONLY, unlike all three of its neighbours, and that follows from
          -- a design decision rather than luck. The session — the one piece of
          -- state this feed must keep — is a row in MariaDB, not a file: see
          -- `telegram::session` for why (a PVC that one pod writes is how
          -- `messages` spent 26 hours answering 502 over a 0400 file it could no
          -- longer write). Nothing else here touches a filesystem, so there is no
          -- `why` to write down.
          rootFs = T.RootFs.ReadOnly
        , env =
          [ { name = "DB_HOST", value = lit "signal-db" }
          , { name = "DB_NAME", value = lit "signal" }
          , { name = "DB_USER", value = secret keys.DB_USER }
          , { name = "DB_PASSWORD", value = secret keys.DB_PASSWORD }
          , { name = "TELEGRAM_API_ID", value = secret keys.TELEGRAM_API_ID }
          , { name = "TELEGRAM_API_HASH", value = secret keys.TELEGRAM_API_HASH }
          , { name = "TELEGRAM_MEDIA_DIR", value = lit telegramMediaMount }
          ]
        , probeTiming = T.standardTiming
        , -- ⚠ INERT under `Unprobed`, like the ingester, and for a reason worth
          -- stating rather than inheriting: there is nothing here a probe could
          -- ask. The process holds an outgoing connection and listens on no port,
          -- so a `tcpSocket` check would be answered by nothing, and a liveness
          -- file would say only "this process was alive a moment ago" — which is
          -- what irc-tail's heartbeat says, and it needs that because a long poll
          -- which has stopped asking looks identical to a quiet channel. This one
          -- does not have that failure mode: if the update stream ends, the task
          -- ends, and the process ends with it.
          probe = T.Probe.Unprobed
        , resources = Some
          { requests = { cpu = "50m", memory = "64Mi" }
          , -- Bounded by construction: no media is downloaded (a Telegram photo is
            -- recorded as having BEEN a photo), and a history page is 100 messages
            -- of text. The session's peer cache is the only thing that grows with
            -- the account, and it is thousands of small records rather than
            -- anything proportional to the archive. 128Mi is the ceiling the
            -- ingester carries, with the same meaning: a kill at it is a leak
            -- rather than a big message.
            --
            -- No cpu limit, for the ingester's reason: a throttle would stall an
            -- ingest nobody is waiting on and show up as latency nobody can
            -- attribute.
            limits = Some { cpu = None Text, memory = "128Mi" }
          }
        , -- ⚠ **ONE VOLUME, AND THE `rootFs = ReadOnly` ABOVE STILL HOLDS.** The
          -- feed's own STATE is still a database row — the session — and nothing
          -- here writes to the container's root. What this mounts is the place
          -- fetched pictures go, which is a volume precisely so that it is not the
          -- root filesystem. The ingester's `RootFs.Writable` reason next door names
          -- /tmp scratch as well as its mount; this needs neither.
          volumes =
          [ { name = "media"
            , source = T.VolumeSource.Claim claims.telegramMedia
            }
          ]
        , mounts =
          [ { name = "media"
            , mountPath = telegramMediaMount
            , subPath = None Text
            , readOnly = False
            }
          ]
        , tasks = [] : List T.ScheduledTask
        }
      ]
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
          , { -- ⚠ THREE RULES NOW NAME THE SAME ADDRESS AND PORT, and that is
              -- the honest shape rather than a redundancy to fold away. A
              -- NetworkPolicy's vocabulary stops at "may open 2230"; what
              -- separates these three is the KEY each pod presents, and each is
              -- pinned to a different forced command on the far side —
              -- `irclog-pull` reads the log tree, `irc-send` speaks, `irc-tail`
              -- listens. Merging them into one namespace-wide rule would hand
              -- every pod here the union of three capabilities it cannot
              -- exercise but should not be granted.
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
          , { -- The `messages` viewer's SSO callback, declared here because
              -- this is the namespace that owns the policies even though the
              -- workload's tree is `kubes/messages/`.
              --
              -- ⚠ AN `ipBlock` WORKS HERE ONLY BECAUSE THE FRONT DOOR IS A HOST
              -- PROCESS. #781 found the same rule matching nothing and selected
              -- klipper's svclb pod instead, correctly for the time: svclb held
              -- :443 by CNI hostport DNAT, so the packet was rewritten before
              -- kube-router's filter rules saw it. No such DNAT entry survives
              -- now. A "cannot be named" verdict outlives the arrangement that
              -- produced it — re-measure before trusting one.
              name = "messages-egress-sso"
            , target = T.NetpolTarget.OneWorkload "messages"
            , egress =
              [ { to =
                  [ T.NetpolPeer.Host
                      { cidr = "${isisFrontDoor}/32"
                      , why =
                          "the Nextcloud token exchange: dash.xinutec.org resolves to isis's own address, where host nginx terminates TLS, so the packet is routed locally and never reaches the wire"
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
          , { -- ⚠ **THE ONE POD IN THIS NAMESPACE THAT MAY LEAVE IT**, and it is a
                -- scheduled batch job rather than the web app on purpose: a picture
                -- somebody linked is fetched here and reaches the reader as bytes on
                -- a volume, so `messages` itself keeps having no route to the
                -- internet at all. See `messages-link-fetch` in `apps/messages.dhall`.
                --
                -- ⚠ **`except` IS THE SECURITY CONTROL, not a tidy-up.** The fetcher
                -- follows links that strangers wrote into a chat years ago, so the
                -- one thing it must never be talked into is reaching back inside:
                -- the private ranges and the VPN are carved out HERE, at the network,
                -- where an app-level check cannot be argued past by a redirect, a
                -- DNS answer that resolves inward, or a page naming an internal
                -- address. The app also refuses an off-origin picture; this is the
                -- half that does not depend on the app being right.
                name = "messages-link-fetch-egress"
            , target = T.NetpolTarget.OneWorkload "messages-link-fetch"
            , egress =
              [ { to =
                  [ T.NetpolPeer.Internet
                      { -- The same five as `signal-cli-egress-internet` above,
                        -- and for a sharper reason: that one talks to a server
                        -- it chose, this one follows links strangers wrote into
                        -- a chat years ago.
                        except =
                        [ "10.0.0.0/8"
                        , "172.16.0.0/12"
                        , "192.168.0.0/16"
                        , "169.254.0.0/16"
                        , "127.0.0.0/8"
                        ]
                      }
                  ]
                , ports =
                  [ { port = 443, protocol = "TCP" }
                  , { port = 80, protocol = "TCP" }
                  ]
                }
              ]
            }
          , { -- The Telegram feed reaches Telegram, and nothing inside.
              --
              -- ⚠ **THE SAME FIVE CARVE-OUTS, and the reason sits between the two
              -- above.** The bridge talks to a server it chose; the link fetcher
              -- follows links strangers wrote. This one talks to a server it chose
              -- — Telegram's datacentres — but everything it then parses is
              -- content those strangers control, over a protocol this fleet speaks
              -- through a crate whose author says it has not been audited
              -- (`grammers`). So the reach is carved at the network, where being
              -- wrong about a parser costs nothing inward.
              --
              -- ⚠ It needs 3306 to `signal-db` as well, and does NOT get it here:
              -- that is `signal-db-from-app-only`, which admits the whole
              -- namespace. A second policy naming this workload for the database
              -- would be a second statement of one fact.
              name = "${telegram}-egress-internet"
            , target = T.NetpolTarget.OneWorkload telegram
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
                , -- ⚠ 443 ALONE. MTProto has several transports — 80, 443, 5222
                  -- and Telegram's obfuscated ports — and `grammers` dials 443. A
                  -- wider hole would grant reach that nothing uses, which is the
                  -- kind of allowance nobody later dares remove.
                  ports = [ { port = 443, protocol = "TCP" } ]
                }
              ]
            }
          ]
    }
    : T.Namespace
