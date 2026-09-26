{-
`vaultwarden` — the password vault.

⚠ **ADOPTED FROM A HAND-WRITTEN TREE, so this file models what IS and not what
would be tidy.** Three fields exist only to match the live objects, and changing
any of them moves or orphans data:

  * the claim is named `vaultwarden-data`, NOT the derived `vaultwarden-data-pvc`
    — a differently-named PVC is a NEW EMPTY VOLUME, and the vault would come up
    blank with its real data orphaned;
  * `storageClass` is stated because it is IMMUTABLE on a live PVC and recorded
    in last-applied-configuration — a manifest dropping it is REJECTED on apply;

**Non-root since 2026-09-26** (task #1762). It ran as root against a 0777 root-owned
volume until then; the move was a watched deploy of its own, with a verified
`.backup` of the database taken first.

  * `uid` 65532 and `FsGroup`: the claim is a `local` PV, which Kubernetes does
    apply `fsGroup` to, so every start gives the data to group 65532 with group
    write. The first start made that change to the live database (under 2 MB),
    with the pod stopped, as `Recreate` guarantees.
  * **The container listens on 8080** (`ROCKET_PORT`): `NonRoot` drops every
    capability, and a non-root process cannot bind :80 without one. The Service
    and the front door stay on 80, because `servicePort` is 80 for any app
    behind an Ingress and forwards to this port.
-}

let T = ./../lib/types.dhall

let dns = ./../dns.dhall

let port = 8080

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
            T.Image.Upstream { repo = "vaultwarden/server", tag = "1.37.3-alpine" }
        , port
        , uid = 65532
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , rootFs =
            T.RootFs.Writable
              { why =
                  "third-party image, and that filesystem is not ours to constrain: a release that began using /tmp would take the vault down on a routine image bump. ⚠ Not because the filesystem is busy — checked against the live pod, /tmp is empty and the process holds no write handle outside /data, so read-only would hold TODAY. It is refused because that would bind one release"
              }
        , volumeOwnership = T.VolumeOwnership.FsGroup
        , -- Bitwarden clients' sync payloads exceed nginx's 1m default.
          maxBodySize = Some "128m"
        , env =
          [ { name = "DOMAIN"
            , value = T.EnvValue.Literal "https://vault.xinutec.org"
            }
          , -- Rocket's own listen port; see the header for why it is not 80.
            { name = "ROCKET_PORT", value = T.EnvValue.Literal (Natural/show port) }
          , -- ⚠ Single-user instance: the one account is registered and signups
            -- are closed behind it. Re-opening these is a security decision.
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
