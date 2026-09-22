let T =
      -- messages.xinutec.org — a reader for the Signal archive.
      --
      -- ⚠ IT DOES NOT OWN ITS NAMESPACE. The pod runs in `signal`, created by
      -- `kubes/signal/k8s`, because a `secretKeyRef` CANNOT CROSS NAMESPACES and this
      -- reads `signal-secret`. Everything unusual below follows — see `T.Owner`:
      --
      --   * no `00-namespace.yaml`, and no `allow-no-netpol` waiver even though this
      --     tree renders no policy — the namespace IS defended, by signal's tree;
      --   * `messages-secret` and `messages-tls`, not `signal-*`: only `meta`'s
      --     namespace field uses `signal`.
      --
      -- ⚠ `fsGroup` and `fsGroupChangePolicy` are stated, so reading the attachments
      -- is PERMITTED rather than an accident of the ingester's fsGroup having set the
      -- volume's group. `OnRootMismatch` keeps it cheap: the root already carries the
      -- gid, so kubelet checks and skips rather than re-chowning the volume.
      ../lib/types.dhall

let claims = ../signal-claims.dhall

let port = 8080

let attachmentsPath = "/attachments"

let telegramMediaPath =
      --| The same path the Telegram feed writes to, read-only here.
      --
      -- ⚠ Identical on both sides ON PURPOSE. The database stores a file NAME, not a
      -- path, so that a remount cannot leave rows pointing at nothing — and a name
      -- only means the same thing in two pods if the directory does too.
      "/telegram-media"

let linkImagesPath = "/link-images"

let linkImages
    : T.Claim.Type
    =
      --| Pictures fetched for links people posted — see `link_image.rs` in the app.
      --
      -- This tree may create it because only this tree's workloads touch it: the
      -- scheduled fetcher writes, the reader mounts read-only. `signal-claims.dhall`
      -- is for the other case, where two TREES must agree about one volume.
      --
      -- A cache. Losing it costs the pictures whose shares have since gone, which is
      -- accepted: the conversation still holds the link, and backing this up would
      -- mean keeping copies of other people's files against the day their own server
      -- forgets them.
      T.Claim::{ name = "messages-link-images-pvc"
      , storageGi = 2
      , durability =
          T.Durability.LossAccepted
            { why =
                "a cache of pictures behind links; the links themselves are in the archive, and what is still live re-fetches"
            }
      , writers =
          T.Writers.Concurrent
            { why =
                "the link-fetch task writes, the messages pod reads it readOnly"
            }
      , chown = T.FsGroupChange.OnRootMismatch
      }

let sendKeySecret =
      -- The send path. `messages` is a reader everywhere else; this is the one thing
      -- it does that leaves the cluster and the one thing it does that another person
      -- sees.
      --
      -- ⚠ THE KEY IS ITS OWN SECRET, not a field in `messages-secret`, for the same
      -- reason the importer's is: it is a credential to a DIFFERENT CLUSTER with a
      -- different lifetime. Rotating the session secret should not mean touching a
      -- key that is authorised on amun, and vice versa.
      "messages-irc-send"

let sendKeyMount = "/ssh-irc"

let sendWorkMount =
      -- ⚠ A WRITABLE SCRATCH DIRECTORY IS REQUIRED, and only because of how ssh reads
      -- key permissions. The secret volume is mounted 0444 — 0400 would be unreadable,
      -- since a secret volume's files belong to root rather than to `runAsUser`, and
      -- it fails wearing an unrelated error ("no host key known") because an
      -- unreadable known_hosts is indistinguishable from an empty one. But ssh then
      -- refuses a key carrying any group or other bit, whatever the volume says. So
      -- the key is copied to 0400 before use, and `RootFs.ReadOnly` means there is
      -- nowhere to copy it to without this.
      "/run/irc"

let keys =
      -- This app's OWN secret, `messages-secret`. The archive's DB credentials are
      -- NOT here: they live in `signal-secret`, which this model does not manage, and
      -- `T.EnvValue.FromUnmanagedSecret` is how a model says it expects to find a key
      -- in someone else's secret.
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
    , labels = [] : T.Labels
    , unowned = [] : List T.Unowned
    , acme = None T.AcmeDelegation
    , tree = None Text
    , placement = T.on T.Cluster.isis
    , -- It reads signal's. The `sessions` table it owns is created on boot in
      -- that same database, which is why there is no second one to declare.
      db = None T.Database
    , configMap = None T.ConfigMapDoc
    , -- The attachments claim it mounts is signal's — `claims` is what a tree
      -- CREATES, and `VolumeSource.Claim` carries the claim value, so mounting
      -- one this tree does not own needs nothing here. The link-images volume is
      -- this tree's own: only its workload and its task touch it.
      claims = [ linkImages ]
    , workloads =
      [ T.Workload::{ name = "messages"
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
        , port
        , uid = 65532
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , -- Stateless: it serves a bundle and reads a read-only mount, and
          -- writes nothing anywhere.
          rootFs = T.RootFs.ReadOnly
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
          , { name = "TELEGRAM_MEDIA_DIR", value = lit telegramMediaPath }
          , { name = "LINK_IMAGES_DIR", value = lit linkImagesPath }
          , { -- irssi over WireGuard, by address rather than by name: the same
              -- host and port the importer pulls the logs from, reached with a
              -- different key that may only send.
              name = "IRC_SEND_HOST"
            , value = lit "10.100.0.1"
            }
          , { name = "IRC_SEND_PORT", value = lit "2230" }
          , { name = "IRC_SEND_KEY_DIR", value = lit sendKeyMount }
          , { name = "IRC_SEND_WORK_DIR", value = lit sendWorkMount }
          ]
        , probeTiming =
            { readiness = { initialDelaySeconds = 2, periodSeconds = 10 }
            , liveness = Some { initialDelaySeconds = 5, periodSeconds = 20 }
            }
        , probe = T.Probe.Http { path = "/healthz", port }
        , -- ⚠ **NOT `/healthz`, AND THAT IS THE WHOLE POINT.** The line above is
          -- kubelet's LIVENESS target and answers a literal `"ok"`; it has to
          -- stay dumb, because a liveness probe that checks the database turns a
          -- blip into a crashloop. This is the front door's question instead —
          -- can the archive be READ — and it may be expensive and honest.
          --
          -- ⚠ `/` would not do: the Angular bundle is served by the same process,
          -- so `/` answers 200 while the database is unreachable.
          serviceCheck = Some "/healthz/deep"
        , resources =  Some
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
          , { name = "sendkey"
            , source =
                T.VolumeSource.Secret
                  { name = sendKeySecret
                  , -- 0444 rather than 0400; see `sendWorkMount` above for why
                    -- the tighter mode is the unreadable one.
                    mode = Some T.fileMode.anyoneRead
                  }
            }
          , { name = "sendwork", source = T.VolumeSource.EmptyDir }
          , { name = "link-images", source = T.VolumeSource.Claim linkImages }
          , { name = "telegram-media"
            , -- signal's claim again, by value, for the reason `attachments` is.
              source = T.VolumeSource.Claim claims.telegramMedia
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
          , { name = "telegram-media"
            , mountPath = telegramMediaPath
            , subPath = None Text
            , -- The Telegram feed writes these; this pod only shows them.
              readOnly = True
            }
          , { name = "sendkey"
            , mountPath = sendKeyMount
            , subPath = None Text
            , readOnly = True
            }
          , { name = "sendwork"
            , mountPath = sendWorkMount
            , subPath = None Text
            , readOnly = False
            }
          , { name = "link-images"
            , mountPath = linkImagesPath
            , subPath = None Text
            , -- ⚠ **THE READER WRITES THESE, AND THE FETCHER DOES NOT.** That is
              -- the wrong way round until you see what each pod is: this one owns
              -- the archive and the stored pictures and has NO route off the
              -- cluster; the fetcher below has a socket to the internet and
              -- nothing else — no database, no volume, no credential. The bytes
              -- travel between them on one in-cluster request, so a fetcher that
              -- a hostile page has talked into something has nothing to read and
              -- nowhere to write.
              readOnly = False
            }
          ]
        }
      , T.Workload::{ name = "messages-link-fetch"
        , -- ⚠ **THE ONLY THING IN THIS NAMESPACE THAT LEAVES THE CLUSTER, AND THE
          -- ONLY ONE THAT KNOWS NOTHING ELSE.** It follows links strangers wrote
          -- into a chat years ago, so it is the component most likely to meet
          -- something hostile — and there is nothing behind it to take:
          --
          --   * NO env at all, so no database credential. The archive's
          --     `signal-secret` is a field of the workload above, not of this one.
          --   * NO volume. The pictures it returns are written by the reader.
          --   * `Internal`, so nothing outside the cluster can reach it, and the
          --     only caller is the pod that asks it for one URL at a time.
          --
          -- Compromised, it can lie about a picture's bytes — which the remote
          -- server could anyway — and reach the namespace's 3306/8080 without a
          -- credential for either. ⚠ Closing that needs "every pod EXCEPT this",
          -- which `NetpolTarget` cannot express.
          reach = T.Reach.Internal
        , image = T.Image.Fleet "messages"
        , -- Same image, second binary. One build, and the fetcher cannot drift
          -- from the reader's idea of what a picture is.
          command = Some [ "link-fetch" ]
        , port = 8080
        , uid = 65532
        , selector = T.Selector.App
        , hardening = T.Hardening.NonRoot
        , rootFs = T.RootFs.ReadOnly
        , probeTiming =
            { readiness = { initialDelaySeconds = 2, periodSeconds = 10 }
            , liveness = Some { initialDelaySeconds = 5, periodSeconds = 20 }
            }
        , probe = T.Probe.Http { path = "/healthz", port = 8080 }
        , -- ⚠ EMPTY, AND THAT IS THE POINT — stated rather than defaulted. No
          -- database host, no user, no password: a process with no credential
          -- cannot be made to use one.
          env = [] : List T.EnvVar
        , volumes = [] : List T.Volume
        , mounts = [] : List T.VolumeMount
        , resources = Some
          { requests = { cpu = "25m", memory = "64Mi" }
          , limits = Some
            { -- A capped body is 12Mi and it holds one at a time; the ceiling is
              -- what stops a pathological page rather than a guess at a picture.
              cpu = None Text
            , memory = "192Mi"
            }
          }
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
