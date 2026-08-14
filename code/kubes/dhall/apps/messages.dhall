-- messages.xinutec.org — a reader for the Signal archive.
--
-- ⚠ THE FIRST TREE THAT DOES NOT OWN ITS NAMESPACE, and that is the whole
-- reason this file was the last one modelled. Its pod runs in `signal`, which
-- `kubes/signal/k8s` creates, because a `secretKeyRef` CANNOT CROSS NAMESPACES
-- and this app reads `signal-secret` for the archive's database credentials.
-- Everything unusual below follows from that one fact — see `T.Owner`, where it
-- is one field rather than four flags.
--
-- What it means in practice:
--
--   * no `00-namespace.yaml` — signal's tree has it;
--   * no `allow-no-netpol` waiver, though this tree renders no policy: the
--     namespace IS defended, and the rule admitting this pod's SSO callback is
--     declared in `apps/signal.dhall` where the namespace's policies live;
--   * `messages-secret` and `messages-tls`, not `signal-*`: the SLUG names what
--     belongs to the app, and only `meta`'s namespace field uses `signal`;
--   * an Ingress named `messages`, stated rather than derived.
--
-- ⚠ TWO DELTAS against the live tree, both on the pod's `securityContext`, both
-- additive and both measured rather than argued:
--
--   1. `fsGroup: 65532` and 2. `fsGroupChangePolicy: OnRootMismatch`. The live
--   manifest has neither, so this pod reads the attachments only because the
--   INGESTER's fsGroup happened to set the volume's group — an accident of
--   another tree's manifest (`signal/k8s/04-ingester.yaml` lines 24-25, both
--   values identical to these). Stating them makes the read permitted rather
--   than incidental. `OnRootMismatch` is what keeps it cheap: the root already
--   carries gid 65532, so kubelet checks and skips rather than re-chowning
--   20 Gi at every start.
--
-- It costs a pod restart, which for a reader nobody is reading is free.
let T = ../lib/types.dhall

let claims = ../signal-claims.dhall

let port = 8080

let attachmentsPath = "/attachments"

-- This app's OWN secret, `messages-secret`. The archive's DB credentials are
-- NOT here: they live in `signal-secret`, which this model does not manage, and
-- `T.EnvValue.FromUnmanagedSecret` is how a model says it expects to find a key
-- in someone else's secret.
let keys =
      { SESSION_SECRET = "SESSION_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let signalSecret =
      λ(k : Text) →
        T.EnvValue.FromUnmanagedSecret
          { secret = "signal-secret", key = k, optional = False }

let lit = T.EnvValue.Literal

in  { name = "signal"
    , -- ⚠ `name` IS `signal` and that is not a mistake: it is the namespace this
      -- deploys into. What the app is called lives in `slug`.
      owner =
        T.Owner.Elsewhere
          { tree = "signal"
          , slug = "messages"
          , -- The live object, which has no `-ingress` suffix. Renaming it is
            -- delete-then-create rather than apply — the nginx admission
            -- webhook refuses the overlap — so it is stated, not tidied.
            ingressName = "messages"
          }
    , unowned =
      [ { file = "00-letsencrypt-dns-issuer.yaml"
        , why =
            "a cert-manager ClusterIssuer: cluster-scoped one-time isis setup, not part of this or any app. The HTTP-01 issuer the fleet otherwise uses cannot validate a host that resolves to a VPN-only address, so this one proves ownership by a Cloudflare TXT record instead."
        }
      ]
    , cluster = T.Cluster.isis
    , -- It reads signal's. The `sessions` table it owns is created on boot in
      -- that same database, which is why there is no second one to declare.
      db = None T.Database
    , configMap = None T.ConfigMapDoc
    , -- Empty because the claim it mounts is signal's — `claims` is what a tree
      -- CREATES, and `VolumeSource.Claim` carries the claim value, so mounting
      -- one this tree does not own needs nothing here.
      claims = [] : List T.Claim
    , workloads =
      [ { name = "messages"
        , reach =
            T.Reach.Ingress
              { host = "messages.xinutec.org"
              , -- VPN-only by DNS: the host resolves to isis's WireGuard
                -- address. The isis ingress also answers on the public IP, so
                -- this is obscurity rather than a firewall — the Nextcloud
                -- login and the `pippijn`-only allow-list are the real gate.
                -- `VpnOnly` also picks the DNS-01 issuer, which is the part
                -- that is load-bearing: HTTP-01 cannot validate this host.
                exposure = T.Exposure.VpnOnly
              }
        , image = T.Image.Fleet "messages"
        , command = None (List Text)
        , port
        , uid = 65532
        , hardening = T.Hardening.NonRoot
        , -- Stateless: it serves a bundle and reads a read-only mount, and
          -- writes nothing anywhere.
          readOnlyRootFs = True
        , env =
          [ { name = "DB_HOST", value = lit "signal-db" }
          , { name = "DB_NAME", value = lit "signal" }
          , { -- From signal's secret, in signal's namespace. The reason this
              -- pod lives there at all.
              name = "DB_USER"
            , value = signalSecret "DB_USER"
            }
          , { name = "DB_PASSWORD", value = signalSecret "DB_PASSWORD" }
          , { name = "NC_BASE_URL", value = lit "https://dash.xinutec.org" }
          , { name = "NC_REDIRECT_URI"
            , value = lit "https://messages.xinutec.org/auth/callback"
            }
          , { -- The allow-list that is the actual gate. A Nextcloud login alone
              -- is not enough: anyone with an account on dash would otherwise
              -- read the archive.
              name = "ALLOWED_USERS"
            , value = lit "pippijn"
            }
          , { name = "SESSION_SECRET", value = secret keys.SESSION_SECRET }
          , { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
          , { name = "ATTACHMENTS_DIR", value = lit attachmentsPath }
          ]
        , probeTiming =
            { readiness = { initialDelaySeconds = 2, periodSeconds = 10 }
            , liveness = { initialDelaySeconds = 5, periodSeconds = 20 }
            }
        , probe = T.Probe.Http { path = "/healthz", port }
        , resources =
          { requests = { cpu = "25m", memory = "64Mi" }
          , limits = Some
            { -- Memory only, and `T.Limits` exists so this can be said. A CPU
              -- cap on a reader that spends its time waiting on a database
              -- would buy throttling and nothing else.
              cpu = None Text
            , memory = "256Mi"
            }
          }
        , volumes =
          [ { name = "attachments"
            , -- signal's claim, mounted by its VALUE. See `signal-claims.dhall`
              -- for why a name would not do.
              source = T.VolumeSource.Claim claims.attachments
            }
          ]
        , mounts =
          [ { name = "attachments"
            , mountPath = attachmentsPath
            , subPath = None Text
            , -- The ingester writes these; this pod only shows them. RWO is
              -- satisfied because both pods land on the one node.
              readOnly = True
            }
          ]
        , tasks = [] : List T.ScheduledTask
        }
      ]
    , secrets = toMap keys
    , -- No policy of its own, and NOT because the namespace is undefended: the
      -- rule that lets this pod reach the ingress controller for its SSO
      -- callback is `messages-egress-sso` in `apps/signal.dhall`. A namespace's
      -- policies belong to the tree that owns the namespace, or two trees write
      -- the same object.
      netpol = T.Netpol.Unpoliced
    }
    : T.Namespace
