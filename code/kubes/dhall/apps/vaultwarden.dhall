{-
`vaultwarden` — the password vault, and the tree that named `VolumeOwnership.RunsAsRoot`.

⚠ **ADOPTED FROM A HAND-WRITTEN TREE, so this file models what IS and not what
would be tidy.** Three fields exist only to match the live objects, and changing
any of them moves or orphans data:

  * the claim is named `vaultwarden-data`, NOT the derived `vaultwarden-data-pvc`
    — a differently-named PVC is a NEW EMPTY VOLUME, and the vault would come up
    blank with its real data orphaned;
  * `storageClass` is stated because it is IMMUTABLE on a live PVC and recorded
    in last-applied-configuration — a manifest dropping it is REJECTED on apply;
  * `volumeOwnership` emits no `fsGroup`, because one would trigger a recursive
    chown of the live sqlite database.

⚠ **THE PORT STAYS 80, and the reasoning that said otherwise was wrong.** I read
`containerSecurityContext` as unconditional and concluded `capabilities.drop =
["ALL"]` would take `CAP_NET_BIND_SERVICE` and stop this container binding :80.
It is emitted only for `Hardening.NonRoot` (`render.dhall:1139`) — and the comment
there gives the reason: `drop: ALL` takes the capabilities a root entrypoint
needs, so hardening the pod but not the container "crash-loops it just the same".
An `Unhardened` container keeps its capabilities. **So there is no port move, no
`ROCKET_PORT`, and no Service change.**
-}

let T = ./../lib/types.dhall

let dns = ./../dns.dhall

let port = 80

let keys = { ADMIN_TOKEN = "ADMIN_TOKEN" }

let data =
      T.Claim::{
      , -- ⚠ The LIVE claim's name. See the header: renaming it loses the vault.
        name = "vaultwarden-data"
      , storageGi = 5
      , -- Every credential Pippijn has. There is no weaker answer available.
        durability = T.Durability.BackedUp
      , -- One RWO claim holding a sqlite database: two pods writing it at once
        -- is corruption, so `Exclusive` renders `strategy: Recreate`, which the
        -- live Deployment already states for exactly that reason.
        writers = T.Writers.Exclusive
      , -- ⚠ IMMUTABLE on the live PVC; omitting it makes the apply fail.
        storageClass = Some "local-path"
      , chown = T.FsGroupChange.Always
      }

in  { name = "vaultwarden"
    , owner = T.Owner.Own
    , labels = [] : T.Labels
    , placement = T.on T.Cluster.isis
    , db = None T.Database
    , configMap = None T.ConfigMapDoc
    , claims = [ data ]
    , secrets = toMap keys
    , unowned = [] : List T.Unowned
    , netpol = T.Netpol.Unpoliced
    , acme = None T.AcmeDelegation
    , tree = None Text
    , workloads =
      [ T.Workload::{
        , name = "vaultwarden"
        , -- ⚠ `VpnOnly` is what this whole tree was modelled FOR: until it had an
          -- `exposure` field it could not appear in any allowlist derived from the
          -- model, and a front door built from the model would have silently left
          -- the vault on the public interface (#1300).
          reach =
            T.Reach.Ingress { host = dns.vault, exposure = T.Exposure.VpnOnly }
        , image =
            T.Image.Upstream { repo = "vaultwarden/server", tag = "1.37.0-alpine" }
        , port
        , -- Unused: `Unhardened` drops the identity fields and `RunsAsRoot` emits
          -- no `fsGroup`, so nothing reads this. 0 is the honest value.
          uid = 0
        , selector = T.Selector.App
        , hardening =
            T.Hardening.Unhardened
              { why =
                  "the alpine image's process runs as root; non-root additionally needs an fsGroup ownership migration of the live /data sqlite DB (currently 0777 root:root), which is a deliberate watched deploy of its own and must not ride along with this one"
              }
        , rootFs =
            T.RootFs.Writable
              { why =
                  "third-party image: it writes its own /tmp and rocket state, and that filesystem is not ours to constrain"
              }
        , volumeOwnership =
            T.VolumeOwnership.RunsAsRoot
              { why =
                  "the process is root against a 0777 root-owned volume, so ownership is already correct; an fsGroup would add a field the live pod does not carry AND recursively chown the vault's sqlite database"
              }
        , -- Bitwarden clients' sync payloads exceed nginx's 1m default.
          maxBodySize = Some "128m"
        , env =
          [ { name = "DOMAIN"
            , value = T.EnvValue.Literal "https://vault.xinutec.org"
            }
          , -- ⚠ Single-user instance: pippijn registered 2026-06-10 and signups
            -- were closed behind him. Re-opening these is a security decision.
            { name = "SIGNUPS_ALLOWED", value = T.EnvValue.Literal "false" }
          , { name = "INVITATIONS_ALLOWED", value = T.EnvValue.Literal "false" }
          , { name = "SHOW_PASSWORD_HINT", value = T.EnvValue.Literal "false" }
          , { name = "ADMIN_TOKEN"
            , value =
                T.EnvValue.FromSecret { key = keys.ADMIN_TOKEN, optional = False }
            }
          ]
        , probeTiming =
            { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
            , -- None, matching the live pod. A liveness probe that restarts a
              -- vault mid-write buys nothing a readiness probe does not.
              liveness = None { initialDelaySeconds : Natural, periodSeconds : Natural }
            }
        , -- `/alive` returns 200 with the server time, so a crashing build is
          -- caught instead of marked Ready.
          probe = T.Probe.Http { path = "/alive", port }
        , resources = Some
          { requests = { cpu = "50m", memory = "128Mi" }
          , limits = Some { cpu = None Text, memory = "512Mi" }
          }
        , volumes = [ { name = "data", source = T.VolumeSource.Claim data } ]
        , mounts =
          [ { name = "data", mountPath = "/data", subPath = None Text, readOnly = False }
          ]
        }
      ]
    }
    : T.Namespace
