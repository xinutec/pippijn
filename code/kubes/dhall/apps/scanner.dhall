-- scanner's fleet tier: the Rust preview server (axum + resvg) that turns the
-- phone's per-photo OCR posts into the progressive styled SVG. Stateless bar the
-- session recordings on its volume. The engine's dev loop stays on the Mac
-- (replay + scoreboard against those recordings); this is the stable deployment
-- the phone talks to by default — reachable from anywhere over the VPN, which
-- the Mac's LAN server never was.
--
-- The FIRST app in the model whose image is neither built by CI nor pulled from
-- a registry, and the first with no Ingress at all. Both are types now rather
-- than comments: `Image.Local` and `Reach.WireGuard`.
let T = ../lib/types.dhall

let dataPath = "/srv/data"

in  T.namespaceOf
      (     { name = "scanner"
      , placement = T.on T.Cluster.isis
      , db = None T.Database
      , storage = Some
        { -- Session recordings: a few MB each, kept so the Mac's replay
          -- scoreboard has real input to score against.
          storageGi = 10
        , mountPath = dataPath
        , -- ⚠ NO subPath, and that is load-bearing. The server reads and writes
          -- cwd-relative `data/` with WorkingDir /srv, so the mount is the
          -- volume ROOT. Giving it one would point the container at an empty
          -- child, and to the app that is indistinguishable from every recorded
          -- session having been lost — kubelet would mount it happily and say
          -- nothing. `T.Storage.subPath` is Optional for this.
          subPath = None Text
        , writers =
            -- The live manifest says it in these words: "single RWO PVC — never
            -- two pods writing sessions at once". Renders `strategy: Recreate`,
            -- which the hostPort would force anyway — a second pod cannot bind
            -- 8090 while the first holds it, so a rolling update would hang
            -- rather than merely overlap.
            T.Writers.Exclusive
        , durability =
            T.Durability.LossAccepted
              { why =
                  "scanner's sessions are recordings of scans the Mac still holds; they are input for replay scoring rather than a primary copy"
              }
        , chown = T.FsGroupChange.Always
        }
      , -- Configured entirely from the environment; no files to mount.
        configMap = None T.ConfigMapDoc
      , workload =
        { -- No Ingress and no DNS record, deliberately. The shared nginx ingress
          -- answers on isis's PUBLIC IP whatever DNS says, so an Ingress here
          -- would be obscurity rather than a gate; scans are private documents.
          -- `WireGuard` is a hostPort DNAT'd to the tunnel address only, which is
          -- a network-layer gate — and `T.wgAddress` derives the hostIP from
          -- `cluster`, because a bare hostPort DNATs on every address the node
          -- has and the rule bypasses the NixOS firewall entirely.
          reach = T.Reach.WireGuard
        , name = "scanner"
        , -- NOT on Docker Hub. The scanner repo is local-only — its eval golden
          -- embeds a private letter — so there is no CI and no registry;
          -- server/deploy/deploy-isis.sh builds the image on isis with nix and
          -- imports it into containerd. `Image.Local` carries
          -- `imagePullPolicy: Never` with it, so a pull attempt (which would
          -- reach whatever stranger holds that name) is a loud error rather
          -- than a silent substitution.
          image = T.Image.Local "scanner"
        , command = None (List Text)
        , port = 8090
        , uid = 1000
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , rootFs = T.RootFs.ReadOnly
        , env = [] : List T.EnvVar
        , readiness = None T.Readiness
        , probeTiming =
            -- Its own, not `standardTiming`: it answers /healthz in about three
            -- seconds, and being reached by a hostPort it cannot roll, so every
            -- second of readiness delay is a second of downtime on each deploy.
            { readiness = { initialDelaySeconds = 3, periodSeconds = 10 }
            , liveness = { initialDelaySeconds = 10, periodSeconds = 30 }
            }
        , probe = T.Probe.Http { path = "/healthz", port = 8090 }
        , resources =
          { requests = { cpu = "100m", memory = "128Mi" }
          , -- Fusion is CPU-bound per post; two of isis's four cores is the
            -- ceiling, which leaves two for everything else on the node.
            limits =
            Some { cpu = Some "2", memory = "1Gi" }
          }
        , volumes = [] : List T.Volume
        , mounts = [] : List T.VolumeMount
        , tasks = [] : List T.ScheduledTask
        }
      , secrets = [] : List T.SecretKey
      , -- Default-deny egress with NO exceptions: it talks to nothing outside
        -- its own pod. The empty list is the whole statement rather than a
        -- degenerate case.
        netpol = T.Netpol.Egress ([] : List T.EgressTo)
      }
          : T.App
      )
