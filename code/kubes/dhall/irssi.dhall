{-
`vps-pippijn` and `vps-simon` — one expression, two namespaces.

A file of their own for the same reason as `signal-claims.dhall`: not tidiness.
The two live manifests are byte-identical apart from THREE values — the namespace
name, `IRSSI_USER`, and the hostPort (2230/2231) — and they are two deployments
of ONE image, whose Dockerfile, `init.sh` and both home trees live together under
`vps/irssi/`. Restating the whole workload twice would work until one of the two
changed.

⚠ **They were ONE DIRECTORY holding two manifests until 2026-08-27.** `compare`
diffs a whole directory as one set against one model file, so two namespaces
sharing a directory was unmodellable rather than untidy. `generate.sh`'s
`app_tree()` now maps each name to its own directory.

⚠ **A PER-USER SSH ENDPOINT IS WHY THE PORTS DIFFER FROM THE CONTAINER'S.** Every
user's terminal server listens on 22 inside its own pod; they cannot all publish
22 on a shared node, so each gets a distinct hostPort DNAT'd to 22. That the two
numbers may differ was denied by this model until 2026-08-27 — see `T.Published`.
-}

let T = ./lib/types.dhall

let storage =
      T.Claim::{ name = "irssi-storage"
      , storageGi = 5
      , durability = T.Durability.BackedUp
      , writers = T.Writers.Exclusive
      , -- ⚠ Named because the LIVE PVC names it and the field is IMMUTABLE:
        -- a generated manifest that dropped it would be rejected on apply, not
        -- ignored. It is redundant in effect — local-path IS k3s's default — but
        -- the model states what is, not what would be tidy.
        storageClass = Some "local-path"
      , chown = T.FsGroupChange.Always
      }

in  λ(who : { user : Text, hostPort : Natural }) →
      { name = "vps-${who.user}"
      , owner = T.Owner.Own
      , labels = [] : T.Labels
      , placement = T.on T.Cluster.amun
      , db = None T.Database
      , configMap = None T.ConfigMapDoc
      , claims = [ storage ]
      , secrets = [] : List T.SecretKey
      , unowned = [] : List T.Unowned
      , acme = None T.AcmeDelegation
      , netpol = T.Netpol.Unpoliced
      , workloads =
        [ T.Workload::{
          , name = "irssi"
          , -- No Service and no Ingress: the only way in is ssh to the hostPort.
            reach =
              T.Reach.HostPorts
                { published = [ { containerPort = 22, hostPort = who.hostPort } ]
                , why =
                    "users ssh directly to this per-user hostPort, so it must bind the node interface and see the real client IP"
                }
          , image = T.Image.Fleet "irssi"
          , -- The live container spells this out. Redundant — `:latest` defaults
            -- to Always — but stated so the model matches without a rollout.
            pullPolicy = Some "Always"
          , -- Run the entrypoint under bash explicitly: the baked image's
            -- /init.sh still carries a #!/bin/sh shebang while using
            -- `set -o pipefail`, a bash builtin, so dash crashloops it.
            command = Some [ "/bin/bash", "/init.sh" ]
          , port = 22
          , -- The unprivileged user the entrypoint drops to (Dockerfile:
            -- `useradd ... -u 1000 irssi`).
            uid = 1000
          , selector = T.Selector.Run
          , hardening =
              T.Hardening.Unhardened
                { why =
                    "the entrypoint must run as root (starts sshd, manages /etc/ssh host keys, chowns the mounted volumes) before dropping to the unprivileged irssi user"
                }
          , -- ⚠ It is the entrypoint's chown that makes an fsGroup redundant
            -- here, and the live pod carries none. See `T.VolumeOwnership`.
            volumeOwnership =
              T.VolumeOwnership.EntrypointChowns
                { why =
                    "the entrypoint chowns /home/irssi and /etc/ssh_keys as root before dropping privilege, so the kernel does not need to"
                }
          , rootFs =
              T.RootFs.Writable
                { why =
                    "an interactive shell host: the user's own session writes wherever a shell writes, and that filesystem is not ours to constrain"
                }
          , env = [ { name = "IRSSI_USER", value = T.EnvValue.Literal who.user } ]
          , -- Just "is anything listening" — sshd has no health endpoint, and
            -- saying so is honest about what is actually checked.
            probe = T.Probe.Tcp { port = 22 }
          , -- ⚠ **LIVENESS IS DELIBERATELY SLOWER THAN READINESS, and copying
            -- readiness's timing here would have CRASH-LOOPED this pod.**
            -- Measured 2026-08-27 across two starts: 16s to Ready, then 31s on
            -- the very next one. With `initialDelaySeconds = 5` and
            -- `failureThreshold` 3 the kubelet kills at ~25s — before the 31s
            -- start was ready. The entrypoint chowns /home/irssi and
            -- /etc/ssh_keys as root before starting sshd, and that varies with
            -- the home directory.
            --
            -- A liveness probe that kills a container which is merely slow to
            -- start turns a slow boot into a crash loop, which is strictly worse
            -- than having no liveness probe at all.
            probeTiming =
            { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
            , liveness = Some { initialDelaySeconds = 30, periodSeconds = 10 }
            }
          , resources =  Some
            { requests = { cpu = "10m", memory = "64Mi" }
            , limits = Some { cpu = Some "100m", memory = "128Mi" }
            }
          , volumes =
            [ { name = "data", source = T.VolumeSource.Claim storage } ]
          , -- ONE claim at TWO subPaths: the home directory the user lives in,
            -- and the ssh host keys that must survive a restart or every client
            -- sees a changed host key.
            mounts =
              [ { name = "data"
                , mountPath = "/home/irssi"
                , subPath = Some "home"
                , readOnly = False
                }
              , { name = "data"
                , mountPath = "/etc/ssh_keys"
                , subPath = Some "ssh"
                , readOnly = False
                }
              ]
          }
        ]
      }
      : T.Namespace
