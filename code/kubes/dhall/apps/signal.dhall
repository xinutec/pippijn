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
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let lit = T.EnvValue.Literal

let restApiName = "signal-cli-rest-api"

let restApiPort = 8080

-- The claim holding signal-cli's linked-device keys and account state.
--
-- ⚠ SECRET-CLASS: whoever holds it can impersonate the linked device, so its
-- odin backup is sensitive. `LossAccepted` anyway, and the reason is not
-- indifference — the device can be re-linked from the phone, where a restore
-- of these keys onto a second running instance would be a second device
-- claiming to be the same one.
let cliClaim
    : T.Claim
    = { name = "signal-cli-pvc"
      , storageGi = 2
      , durability =
          T.Durability.LossAccepted
            { why = "linked-device keys; re-link from the phone instead" }
      , writers = T.Writers.Exclusive
      , chown = T.FsGroupChange.Always
      }

-- Downloaded attachment blobs, keyed by attachment id.
--
-- ⚠ MOUNTED BY TWO WORKLOADS AND TWO TREES: the ingester writes it, and the
-- `messages` viewer in another repo mounts it read-only. That is why `Writers`
-- is `Concurrent` and why claims belong to the NAMESPACE rather than to a
-- workload. RWO holds because both pods land on the one node.
let attachmentsClaim
    : T.Claim
    = { name = "signal-attachments-pvc"
      , storageGi = 20
      , durability =
          T.Durability.LossAccepted
            { why = "re-downloadable from Signal while the messages remain" }
      , writers =
          T.Writers.Concurrent
            { why =
                "one writer (ingester) and one reader (messages, readOnly)"
            }
      , -- 20 Gi of blobs. Re-chowning them at every pod start buys nothing —
        -- the root already carries the right group after the first mount.
        chown = T.FsGroupChange.OnRootMismatch
      }

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
        , limits = None T.Quantity
        }
      , keys =
        { user = keys.DB_USER
        , password = keys.DB_PASSWORD
        , rootPassword = keys.DB_ROOT_PASSWORD
        }
      }
    , configMap = None T.ConfigMapDoc
    , claims = [ cliClaim, attachmentsClaim ]
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
            limits = None T.Quantity
          }
        , volumes = [ { name = "data", source = T.VolumeSource.Claim cliClaim } ]
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
          , limits = None T.Quantity
          }
        , volumes =
          [ { name = "attachments"
            , source = T.VolumeSource.Claim attachmentsClaim
            }
          ]
        , mounts =
          [ { name = "attachments"
            , mountPath = "/attachments"
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
