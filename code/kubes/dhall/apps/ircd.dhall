{-
`ircd` — InspIRCd, and the tree that named `AcmeDelegation`.

⚠ **THE INGRESS ROUTES NOTHING TO THIS WORKLOAD.** IRC is served on three
hostPorts; the Ingress exists to hold the certificate for `irc.xinutec.net` and to
hand one path to a machine outside the cluster. `Reach.HostPorts` and `acme` are
therefore independent here, which is exactly why they are separate fields.
-}

let T = ./../lib/types.dhall

let storage =
      T.Claim::{
      , name = "ircd-storage"
      , storageGi = 5
      , durability = T.Durability.BackedUp
      , -- hostPort binds the node interface, so two pods cannot coexist during a
        -- rollout. `Exclusive` renders `strategy: Recreate`, which the live
        -- Deployment states for that reason.
        writers = T.Writers.Exclusive
      , -- ⚠ Named because the LIVE PVC names it and the field is IMMUTABLE: a
        -- manifest dropping it is REJECTED on apply, not ignored.
        storageClass = Some "local-path"
      , chown = T.FsGroupChange.Always
      }

in  { name = "ircd"
    , owner = T.Owner.Own
    , labels = [] : T.Labels
    , placement = T.on T.Cluster.isis
    , db = None T.Database
    , configMap = None T.ConfigMapDoc
    , claims = [ storage ]
    , secrets = [] : List T.SecretKey
    , unowned = [] : List T.Unowned
    , netpol = T.Netpol.Unpoliced
    , acme = Some
      { host = "irc.xinutec.net"
      , -- ⚠ **THIS NO LONGER DEFINES A CERTIFICATE.** Until 2026-09-01 it
        -- rendered a `cert-manager.io/cluster-issuer` annotation that was the
        -- SOLE definition of `irc-tls`, and the danger was real: the file once
        -- said `letsencrypt-staging` while the live object had been changed to
        -- prod by hand, so applying it would have reissued IRC's certificate
        -- from an untrusted CA and broken TLS for every connected client (found
        -- by the 2026-07-27 drift sweep, the first run that ever compared ircd).
        -- `security.acme` on the host issues this name now (#1294), so the
        -- annotation is gone and that hazard with it. The field still decides
        -- which socket serves the name.
        exposure = T.Exposure.Public
      , tlsSecret = "irc-tls"
      , -- ⚠ `/barfooze`, NOT `/.well-known`. The live manifest carries the
        -- alternative in a trailing comment; it is a choice, not a typo.
        path = "/barfooze"
      , forwardTo = "xinutec-validation.barfooze.de"
      , serviceName = "certbot-forward"
      , ingressName = "irc-ingress"
      , why =
        [ "The ACME HTTP-01 challenge for irc.xinutec.net is answered by a host"
        , "outside this cluster, so the path that carries it is forwarded there"
        , "rather than served here. Nothing else on this hostname is routed."
        ]
      }
    , tree = None Text
    , workloads =
      [ T.Workload::{
        , name = "inspircd"
        , containerName = Some "ircd"
        , -- ⚠ hostPort so inspircd sees the REAL client IP. Spam tracking, bans
          -- and WHOIS all read it, and a Service would NAT it to the load
          -- balancer's. Three ports from one container, which is why `published`
          -- is a list.
          reach =
            T.Reach.HostPorts
              { published =
                [ { containerPort = 6697, hostPort = 6697 }
                , { containerPort = 7005, hostPort = 7005 }
                , { containerPort = 7776, hostPort = 7776 }
                ]
              , why =
                  "inspircd reads the client IP for spam tracking, bans and WHOIS, and a Service would replace it with the load balancer's"
              }
        , image = T.Image.Fleet "ircd"
        , -- Stated by the live container. Redundant — `:latest` implies Always —
          -- but modelled so the model matches without a rollout.
          pullPolicy = Some "Always"
        , port = 6697
        , -- The image's own `USER irc`. Every IRC port is above 1024, so no root
          -- is needed and the Deployment declares it to stop a rollout regressing.
          uid = 39
        , selector = T.Selector.Run
        , hardening = T.Hardening.NonRoot
        , volumeOwnership = T.VolumeOwnership.FsGroup
        , rootFs =
            T.RootFs.Writable
              { why =
                  "inspircd rewrites conf/secret/permchannels.conf as permanent channels, topics and modes change, and rehashes its own configuration in place"
              }
        , env = [] : List T.EnvVar
        , -- Just "is anything listening on the TLS port". inspircd has no health
          -- endpoint, and saying so is honest about what is checked.
          probe = T.Probe.Tcp { port = 6697 }
        , -- ⚠ NO LIVENESS PROBE, and that is what the live Deployment says rather
          -- than an omission in this model. Adding one would be a cluster change
          -- to satisfy a type — and a risky one: a liveness probe that kills a
          -- container merely slow to start turns a slow boot into a crash loop,
          -- and every connected IRC client reconnects each time.
          probeTiming =
          { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
          , liveness =
              None { initialDelaySeconds : Natural, periodSeconds : Natural }
          }
        , -- ⚠ The live container states NO resources at all. Inventing a request
          -- to satisfy the type would restart a running IRC server for the
          -- model's convenience.
          resources = None T.Resources
        , volumes =
          [ { name = "data", source = T.VolumeSource.Claim storage }
          , { name = "tls"
            , -- ⚠ 0444, not 0400: inspircd runs as uid 39 and the projection is
              -- root-owned, so owner-read would leave the process unable to read
              -- its own certificate. A server certificate and its key, in a pod
              -- running only that server.
              source =
                T.VolumeSource.Secret
                  { name = "irc-tls", mode = Some T.fileMode.anyoneRead }
            }
          ]
        , mounts =
          [ { name = "data"
            , mountPath = "/etc/inspircd/conf/secret"
            , subPath = Some "secret"
            , readOnly = False
            }
          , { name = "data"
            , mountPath = "/etc/inspircd/data"
            , subPath = Some "data"
            , readOnly = False
            }
          , { name = "tls"
            , mountPath = "/etc/inspircd/conf/tls"
            , -- ⚠ NO subPath, and that is the whole point rather than an
              -- omission. A subPath mount is copied once at start and NEVER
              -- refreshed by the kubelet, so mounting the certificate that way
              -- reproduces the exact bug this mount fixed — a renewed secret that
              -- never reaches the process — while looking solved. Mounted as a
              -- directory the projection updates in place, and init.sh's poll
              -- notices and rehashes.
              subPath = None Text
            , readOnly = True
            }
          ]
        }
      ]
    }
    : T.Namespace
