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

--| amun over the WireGuard tunnel, not `amun.xinutec.org`.
--
-- ⚠ The public name resolves to 94.23.247.133 and routes out of the building
-- and back; the tunnel address is a direct peer (isis 10.100.0.2 ↔ amun
-- 10.100.0.1, measured 2026-08-14). Both work. This one keeps thirteen years of
-- private conversation off the public path even in the seconds it would be
-- inside an ssh session, and it is the address the NetworkPolicy names, so
-- using the other would be blocked anyway.
let amunTunnel = "10.100.0.1"

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
    , unowned = [] : List T.Unowned
    , cluster = T.Cluster.isis
    , db = Some
      { dbName = "signal"
      , innodbBufferPoolGi = None Natural
      , -- Text messages are small; 10Gi covers years plus the history backfill.
        storageGi = 10
      , resources =
        { requests = { cpu = "50m", memory = "256Mi" }
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
        , -- It writes its own data dir and whatever the JVM wants; this is a
          -- third-party image and its filesystem is not ours to constrain.
          readOnlyRootFs = False
        , env = [ { name = "MODE", value = lit "json-rpc" } ]
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
        , -- It writes downloaded blobs under /attachments (a mount) and may use
          -- /tmp scratch.
          readOnlyRootFs = False
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
        , resources =
          { requests = { cpu = "50m", memory = "64Mi" }
          , limits = None T.Limits
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
            , -- Hourly, off the hour. IRC is a conversation happening now, so
              -- the phone wants it soon; hourly is the compromise against
              -- waking a tunnel and re-walking 11,885 files for nothing.
              schedule = "17 * * * *"
            , -- ⚠ TWO STEPS, so a shell. The logs are on the OTHER CLUSTER —
              -- irssi runs in `vps-pippijn` on amun — so they are pulled over
              -- ssh into `${irclogMount}` and imported from there. The far side
              -- pins this key to `rrsync -ro`, so what this command can do
              -- there is read that one directory and nothing else.
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
              , "install -m 400 ${sshMount}/id_ed25519 /tmp/key && rsync -a -e 'ssh -i /tmp/key -o UserKnownHostsFile=${sshMount}/known_hosts -o StrictHostKeyChecking=yes -p 2230' irssi@${amunTunnel}:xinutec irssi@${amunTunnel}:xinutec2 ${irclogMount}/ && import_irclogs --root ${irclogMount} --network xinutec --network xinutec2 --map xinutec2=xinutec --self-nick \"\$IRC_SELF_NICK\" --self-nick \"\$IRC_SELF_NICK_ALT\" --apply"
              ]
            , -- 20 min. A first run walks the whole tree; every later one
              -- transfers almost nothing and the import is dedupe misses only.
              deadlineSeconds = 1200
            , suspended = False
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
              -- key it presents is pinned to `rrsync -ro` on the far side, so
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
          ]
    }
    : T.Namespace
