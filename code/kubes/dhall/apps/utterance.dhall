-- utterance.xinutec.org — derive music from the structure of a voice
-- (Rust workspace + Angular). Repo: github.com/xinutec/utterance.
--
-- The one fleet app with no database. Its state is files — uploaded recordings
-- and the voiceprints derived from them — so it declares `storage` instead, and
-- is the reason that field exists.
let T = ../lib/types.dhall

let dns = ../dns.dhall

let keys =
      { UTTERANCE_SESSION_SECRET = "UTTERANCE_SESSION_SECRET"
      , NC_CLIENT_ID = "NC_CLIENT_ID"
      , NC_CLIENT_SECRET = "NC_CLIENT_SECRET"
      }

let secret = λ(k : Text) → T.EnvValue.FromSecret { key = k, optional = False }

let lit = T.EnvValue.Literal

let dataPath = "/data"

in    { name = "utterance"
      , cluster = T.Cluster.isis
      , db = None T.Database
      , storage = Some
        { -- The recordings are 51 MB today across fifteen takes, and a take is
          -- a few MB of WAV plus a voiceprint. 5 Gi is room for years of them
          -- at the rate two people record.
          storageGi = 5
        , mountPath = dataPath
        , subPath = "recordings"
        , durability =
            T.Durability.LossAccepted
              { why =
                  "utterance is under heavy development and its uploads are re-derivable; backing it up is deliberately deferred"
              }
        }
      , workload =
        { name = "utterance"
        , image = T.Image.Fleet "utterance"
        , command = None (List Text)
        , port = 8080
        , -- Matches the nonroot user baked into the image (Dockerfile).
          uid = 65532
        , -- Everything it writes goes to the volume above, so the root
          -- filesystem stays read-only.
          readOnlyRootFs = True
        , env =
          [ { name = "DATA_DIR", value = lit dataPath }
          , { -- All three of these must be set or the sign-in gate stays down
              -- and the app serves recordings of two people's voices to
              -- anybody. They are not optional secretKeyRefs for that reason:
              -- a pod that starts without them is worse than one that does not
              -- start.
              name = "UTTERANCE_SESSION_SECRET"
            , value = secret keys.UTTERANCE_SESSION_SECRET
            }
          , { name = "NC_CLIENT_ID", value = secret keys.NC_CLIENT_ID }
          , { name = "NC_CLIENT_SECRET", value = secret keys.NC_CLIENT_SECRET }
          , { name = "NC_BASE_URL", value = lit "https://${dns.dash}" }
          , { -- Where the *pod* reaches Nextcloud. Not the public name: dash
              -- resolves to this node's own public IP, and a pod cannot open a
              -- connection to it — the packet hairpins and is refused. The app
              -- sends the public host as a `Host:` header over this address so
              -- Nextcloud's trusted-domain routing is unchanged.
              name = "NC_INTERNAL_URL"
            , value =
                lit "http://nextcloud-server.nextcloud.svc.cluster.local"
            }
          , { -- Derived from the same hostname the Ingress serves, so the OAuth
              -- callback cannot drift from where the app actually lives.
              name = "NC_REDIRECT_URI"
            , value = lit "https://${dns.utterance}/auth/callback"
            }
          , { -- Two people, named. An empty list would admit every account on
              -- the fleet's Nextcloud, which is not what "private" meant here.
              name = "UTTERANCE_ALLOWED_USERS"
            , value = lit "pippijn,michiel"
            }
          , { name = "RUST_LOG", value = lit "info,utterance=debug" }
          ]
        , probe = T.Probe.Http { path = "/healthz", port = 8080 }
        , resources =
          { requests = { cpu = "50m", memory = "128Mi" }
          , -- Deliberately generous on CPU and capped hard on memory. Analysing
            -- a take runs an FFT over every steady frame and a render
            -- synthesises the whole piece, so this is the one fleet app that
            -- will genuinely saturate a core for seconds at a time — and it
            -- shares this node with Nextcloud, which is the thing that must not
            -- be starved.
            limits = { cpu = "2", memory = "1Gi" }
          }
        , mounts = [] : List T.VolumeMount
        }
      , reach = T.Reach.Ingress
        { host = dns.utterance, exposure = T.Exposure.Public }
      , secrets = toMap keys
      , netpol = True
      }
    : T.App
