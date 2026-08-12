-- A static site → Kubernetes resources.
--
-- The fleet's second kind of deployable, and genuinely a different KIND rather
-- than an `App` with the interesting parts switched off. Four of them live under
-- `web/org/xinutec/`, and what they have in common is not what `T.App` describes:
--
--   * they share ONE namespace (`web`, created by `kubes/web/k8s`), so a site
--     renders no Namespace of its own — `App` always renders one, and a second
--     copy of a shared object is how two trees start fighting over it;
--   * they run a stock `nginxinc/nginx-unprivileged:alpine` rather than an image
--     the fleet builds, so `T.Image.Fleet`'s "`:latest` is the only expressible
--     form" is the wrong rule here — an upstream tag is exactly right;
--   * they select on `run`, not `app`. **A Deployment's `spec.selector` is
--     immutable**, so this is not a convention that can be tidied away: changing
--     it means deleting and recreating four live Deployments.
--
-- What they DO share is the shape below, and it is worth a type because the
-- interesting variation is small and the repetition is large: four near-identical
-- Deployments, four Services whose selector must match, four Ingresses whose
-- backend must name the Service.
let T = ./types.dhall

let K = ./k8s.dhall

let L = ./list.dhall

--| Every site runs this. Pinned, unlike a fleet image: an unpinned nginx would
--  silently major-upgrade the thing serving every static host at once.
let nginxImage = "nginxinc/nginx-unprivileged:alpine"

--| The image runs as uid 101 and listens on 8080 — no root, no privileged-port
--  bind. Both numbers are properties of the IMAGE, not choices per site, so they
--  live here and no site can get them wrong.
let nginxUid = 101

let nginxPort = 8080

--| Where the image looks for what it serves.
let webrootPath = "/usr/share/nginx/html"

let Doc = { mapKey : Text, mapValue : Text }

--| Where the bytes a site serves come from.
let Webroot =
      < --| The image's own default page. Only useful with `overlays`, which is
        --  what `amun` does: the site itself is the stock nginx welcome page and
        --  the only thing that matters is one file under `.well-known/`.
        Stock
      | --| Every served file is a key in a ConfigMap. Suits a site whose content
        --  is small, versioned with the manifest, and changed by re-rendering.
        Config : { files : List Doc }
      | --| A PVC someone pushes content into out of band (a `deploy.sh`). The
        --  claim needs a `T.Durability` for the same reason `T.Storage` does: a
        --  volume whose fate nobody stated is one nobody misses until a restore.
        --
        --  `at` is where it mounts UNDER the webroot — `""` for the whole root,
        --  `/share` to leave the rest of the webroot to the image.
        Volume :
          { storageGi : Natural, durability : T.Durability, at : Text }
      >

--| One ConfigMap file dropped into the webroot by `subPath`, leaving everything
--  around it alone. `.well-known/assetlinks.json` is the motivating case: a
--  whole-directory mount there would hide the site.
--
--  `name` is the ConfigMap's own, spelled out rather than derived: an overlay is
--  an object in its own right whose name predates this model.
let Overlay = { name : Text, path : Text, file : Doc }

--| A host that only redirects. It still needs a certificate — without an Ingress
--  the shared controller answers on 443 with its own fake cert, which is what a
--  browser complains about — and it still needs a backend reference for the rule
--  to parse, though nginx applies the redirect before ever proxying.
let Redirect = { name : Text, host : Text, to : Text, tlsSecret : Text }

let Site =
      { --| Names the Deployment, the Service, the pod label and the Service
        --  selector. One field, so they cannot disagree.
        name : Text
      , --| The site's short name — its first DNS label. Names the Ingress and
        --  the TLS secret, which is why it is not just `name`: the workload is
        --  `httpd-isis` while the Ingress has always been `isis-ingress`, and
        --  renaming a live Ingress costs an outage per host (the nginx admission
        --  webhook refuses the overlap, so it is delete-then-create, not apply).
        slug : Text
      , --| Which k3s cluster serves it. NOT decoration and not derivable: isis
        --  and amun are two clusters and the four sites are split two-and-two
        --  between them. Without this field a site could not say where it lives,
        --  and `scripts/apply.sh` asked whoever was typing — so a dry run
        --  against the wrong cluster reported "nothing exists here", which reads
        --  exactly like a first deploy rather than like a mistake. That
        --  happened, and cost a bug report filed against the wrong cluster.
        --  `apply.sh` now READS this and refuses a `--host` that contradicts it.
        cluster : T.Cluster
      , host : Optional Text
      , replicas : Natural
      , webroot : Webroot
      , overlays : List Overlay
      , --| A `default.conf` for the server block. `None` keeps the image's.
        nginxConf : Optional Text
      , --| Basic auth at the Ingress, naming an existing `namespace/name`
        --  Secret. NOT rendered here and deliberately: it holds a password hash,
        --  and this repository is public.
        auth : Optional Text
      , probePath : Text
      , --| Whether THIS site carries the namespace's `allow-no-netpol` waiver.
        --  `DL-K8S-NP-DEFAULT-DENY` anchors on the FIRST Deployment in a
        --  namespace and all four sites share `web`, so exactly one of them may
        --  carry it — a fact about the group that no site can work out from its
        --  own fields, which is why it is stated rather than derived. dev-lint
        --  fails a waiver that waives nothing, so a second one is caught rather
        --  than silently over-waiving.
        netpolWaiver : Bool
      , redirects : List Redirect
      , --| Files in the live tree this model does NOT produce, each with the
        --  reason. Stating them is what keeps `--check` honest: a manifest the
        --  model has never heard of is a failure, and the only way to make one
        --  not a failure is to say so here, in the model, where a reviewer sees
        --  it. Same discipline as `T.Durability` — the escape hatch exists, and
        --  taking it costs a sentence.
        unowned : List { file : Text, why : Text }
      }

let namespace = "web"

--| The labels the pod template, the Service and the Ingress backend all agree
--  on. One expression; see `K.Labels` for why the map is free-form.
let runLabels
    : Text → K.Labels
    = λ(name : Text) → toMap { run = name }

let meta
    : Text → K.Meta
    = λ(name : Text) →
        { name
        , namespace = Some namespace
        , annotations = None (List Doc)
        , labels = None (List Doc)
        }

let annotated
    : Text → List Doc → K.Meta
    = λ(name : Text) →
      λ(a : List Doc) →
        { name
        , namespace = Some namespace
        , annotations = Some a
        , labels = None (List Doc)
        }

let configName = λ(site : Site) → "${site.slug}-html"

let nginxConfName = λ(site : Site) → "${site.name}-nginx-config"

let pvcName = λ(site : Site) → "${site.name}-storage"

let webrootVolume = "webroot"

let confVolume = "nginx-config"

--| The claim, if the site keeps its content on one.
let volumeOf
    : Site → Optional { storageGi : Natural, durability : T.Durability, at : Text }
    = λ(site : Site) →
        merge
          { Stock = None { storageGi : Natural, durability : T.Durability, at : Text }
          , Config =
              λ(_ : { files : List Doc }) →
                None { storageGi : Natural, durability : T.Durability, at : Text }
          , Volume =
              λ(v : { storageGi : Natural, durability : T.Durability, at : Text }) →
                Some v
          }
          site.webroot

--| The ConfigMap of served files, if the site keeps its content in one.
let filesOf
    : Site → Optional (List Doc)
    = λ(site : Site) →
        merge
          { Stock = None (List Doc)
          , Config = λ(c : { files : List Doc }) → Some c.files
          , Volume =
              λ(_ : { storageGi : Natural, durability : T.Durability, at : Text }) →
                None (List Doc)
          }
          site.webroot

let configMaps
    : Site → List K.ConfigMap
    = λ(site : Site) →
        let content =
              merge
                { None = [] : List K.ConfigMap
                , Some =
                    λ(files : List Doc) →
                      [ { apiVersion = "v1"
                        , kind = "ConfigMap"
                        , metadata = meta (configName site)
                        , data = files
                        }
                      ]
                }
                (filesOf site)

        let conf =
              merge
                { None = [] : List K.ConfigMap
                , Some =
                    λ(body : Text) →
                      [ { apiVersion = "v1"
                        , kind = "ConfigMap"
                        , metadata = meta (nginxConfName site)
                        , data = toMap { `default.conf` = body }
                        }
                      ]
                }
                site.nginxConf

        let overlays =
              L.map
                Overlay
                K.ConfigMap
                ( λ(o : Overlay) →
                    { apiVersion = "v1"
                    , kind = "ConfigMap"
                    , metadata = meta o.name
                    , data = [ o.file ]
                    }
                )
                site.overlays

        in  content # conf # overlays

let pvc
    : Site → List K.PersistentVolumeClaim
    = λ(site : Site) →
        merge
          { None = [] : List K.PersistentVolumeClaim
          , Some =
              λ(v : { storageGi : Natural, durability : T.Durability, at : Text }) →
                [ { apiVersion = "v1"
                  , kind = "PersistentVolumeClaim"
                  , metadata = meta (pvcName site)
                  , spec =
                    { accessModes = [ "ReadWriteOnce" ]
                    , resources.requests.storage
                      = "${Natural/show v.storageGi}Gi"
                    }
                  }
                ]
          }
          (volumeOf site)

--| The backup-coverage waiver this site's claim should carry, or "" for none.
--  Same contract as `render.dhall`'s `storageWaiver`.
let storageWaiver
    : Site → Text
    = λ(site : Site) →
        merge
          { None = ""
          , Some =
              λ(v : { storageGi : Natural, durability : T.Durability, at : Text }) →
                merge
                  { BackedUp = ""
                  , LossAccepted = λ(r : { why : Text }) → r.why
                  }
                  v.durability
          }
          (volumeOf site)

let mounts
    : Site → List K.VolumeMount
    = λ(site : Site) →
        let webroot =
              merge
                { None = [] : List K.VolumeMount
                , Some =
                    λ(v : { storageGi : Natural, durability : T.Durability, at : Text }) →
                      [ { name = webrootVolume
                        , mountPath = "${webrootPath}${v.at}"
                        , subPath = None Text
                        , readOnly = None Bool
                        }
                      ]
                }
                (volumeOf site)

        let served =
              merge
                { None = [] : List K.VolumeMount
                , Some =
                    λ(_ : List Doc) →
                      [ { name = webrootVolume
                        , mountPath = webrootPath
                        , subPath = None Text
                        , readOnly = None Bool
                        }
                      ]
                }
                (filesOf site)

        let overlays =
              L.map
                Overlay
                K.VolumeMount
                ( λ(o : Overlay) →
                    { name = "${o.name}-volume"
                    , mountPath = "${webrootPath}${o.path}"
                    , subPath = Some o.file.mapKey
                    , readOnly = None Bool
                    }
                )
                site.overlays

        let conf =
              merge
                { None = [] : List K.VolumeMount
                , Some =
                    λ(_ : Text) →
                      [ { name = confVolume
                        , mountPath = "/etc/nginx/conf.d/default.conf"
                        , subPath = Some "default.conf"
                        , readOnly = Some True
                        }
                      ]
                }
                site.nginxConf

        in  webroot # served # overlays # conf

let volumes
    : Site → List K.Volume
    = λ(site : Site) →
        let webroot =
              merge
                { None = [] : List K.Volume
                , Some =
                    λ(_ : { storageGi : Natural, durability : T.Durability, at : Text }) →
                      [ { name = webrootVolume
                        , persistentVolumeClaim = Some
                          { claimName = pvcName site }
                        , configMap = None { name : Text }
                        , emptyDir = None {}
                        , hostPath = None { path : Text, type : Text }
                        }
                      ]
                }
                (volumeOf site)

        let served =
              merge
                { None = [] : List K.Volume
                , Some =
                    λ(_ : List Doc) →
                      [ { name = webrootVolume
                        , persistentVolumeClaim = None { claimName : Text }
                        , configMap = Some { name = configName site }
                        , emptyDir = None {}
                        , hostPath = None { path : Text, type : Text }
                        }
                      ]
                }
                (filesOf site)

        let overlays =
              L.map
                Overlay
                K.Volume
                ( λ(o : Overlay) →
                    { name = "${o.name}-volume"
                    , persistentVolumeClaim = None { claimName : Text }
                    , configMap = Some { name = o.name }
                    , emptyDir = None {}
                    , hostPath = None { path : Text, type : Text }
                    }
                )
                site.overlays

        let conf =
              merge
                { None = [] : List K.Volume
                , Some =
                    λ(_ : Text) →
                      [ { name = confVolume
                        , persistentVolumeClaim = None { claimName : Text }
                        , configMap = Some { name = nginxConfName site }
                        , emptyDir = None {}
                        , hostPath = None { path : Text, type : Text }
                        }
                      ]
                }
                site.nginxConf

        in  webroot # served # overlays # conf

let deployment
    : Site → List K.Deployment
    = λ(site : Site) →
        let fsGroup =
            -- Only with a PVC, and equal to the uid nginx runs as: a claim
            -- arrives owned by root, and uid 101 cannot read it otherwise.
              merge
                { None = None Natural
                , Some =
                    λ(_ : { storageGi : Natural, durability : T.Durability, at : Text }) →
                      Some nginxUid
                }
                (volumeOf site)

        let changePolicy =
              merge
                { None = None Text
                , Some =
                    λ(_ : { storageGi : Natural, durability : T.Durability, at : Text }) →
                      Some "OnRootMismatch"
                }
                (volumeOf site)

        in  [ { apiVersion = "apps/v1"
              , kind = "Deployment"
              , metadata = meta site.name
              , spec =
                { replicas = site.replicas
                , strategy = None { type : Text }
                , selector.matchLabels = runLabels site.name
                , template =
                  { metadata.labels = runLabels site.name
                  , spec =
                    { securityContext =
                      { runAsNonRoot = True
                      , runAsUser = nginxUid
                      , runAsGroup = nginxUid
                      , fsGroup
                      , fsGroupChangePolicy = changePolicy
                      , seccompProfile.type = "RuntimeDefault"
                      }
                    , containers =
                      [ { name = site.name
                        , image = nginxImage
                        , command = None (List Text)
                        , -- Stock nginx, run as the image intends: neither its
                          -- entrypoint nor its arguments are ours to set.
                          args = None (List Text)
                        , securityContext =
                          { allowPrivilegeEscalation = False
                          , -- The stock image writes its own /tmp and pid file,
                            -- so the root filesystem stays writable. Carried as
                            -- the `allow-rootfs-rw` waiver on the rendered
                            -- manifest rather than pretended away here.
                            readOnlyRootFilesystem = None Bool
                          , capabilities.drop = [ "ALL" ]
                          }
                        , ports =
                          [ { containerPort = nginxPort
                            , -- A site is reached through the shared ingress,
                              -- never by a port on the node itself.
                              hostPort = None Natural
                            , hostIP = None Text
                            }
                          ]
                        , env = None (List K.EnvVar)
                        , volumeMounts = L.nonEmpty K.VolumeMount (mounts site)
                        , imagePullPolicy = None Text
                        , startupProbe = None K.Probe
                        , livenessProbe = None K.Probe
                        , readinessProbe = Some
                          (     K.emptyProbe
                            ⫽ { httpGet = Some
                                { path = site.probePath, port = nginxPort }
                              , initialDelaySeconds = Some 5
                              , periodSeconds = Some 10
                              }
                          )
                        , -- See `K.Container.resources`: stock nginx, never
                          -- sized, waived rather than invented.
                          resources = None K.Resources
                        }
                      ]
                    , volumes = L.nonEmpty K.Volume (volumes site)
                    }
                  }
                }
              }
            ]

let service
    : Site → List K.Service
    = λ(site : Site) →
        [ { apiVersion = "v1"
          , kind = "Service"
          , -- The Service carries the same `run` label it selects on. One
            -- expression again, so the two cannot drift apart.
            metadata = meta site.name ⫽ { labels = Some (runLabels site.name) }
          , spec =
            { clusterIP = None Text
            , selector = runLabels site.name
            , ports =
              [ { port = 80
                , targetPort = Some nginxPort
                , protocol = Some "TCP"
                }
              ]
            }
          }
        ]

--| The site's own Ingress. Redirects render separately — see `redirect`.
let ingress
    : Site → List K.Ingress
    = λ(site : Site) →
        let issuer = toMap { `cert-manager.io/cluster-issuer` = "letsencrypt-prod" }

        let basicAuth =
              merge
                { None = [] : List Doc
                , Some =
                    λ(secret : Text) →
                      toMap
                        { `nginx.ingress.kubernetes.io/auth-type` = "basic"
                        , `nginx.ingress.kubernetes.io/auth-secret` = secret
                        , `nginx.ingress.kubernetes.io/auth-realm` =
                            "Authentication required"
                        }
                }
                site.auth

        let backend =
              λ(host : Text) →
                { host
                , http.paths =
                  [ { path = "/"
                    , pathType = "Prefix"
                    , backend.service = { name = site.name, port.number = 80 }
                    }
                  ]
                }

        let own =
              merge
                { None = [] : List K.Ingress
                , Some =
                    λ(host : Text) →
                      [ { apiVersion = "networking.k8s.io/v1"
                        , kind = "Ingress"
                        , metadata =
                            annotated "${site.slug}-ingress" (issuer # basicAuth)
                        , spec =
                          { ingressClassName = "nginx"
                          , tls =
                            [ { hosts = [ host ]
                              , secretName = "${site.slug}-tls"
                              }
                            ]
                          , rules = [ backend host ]
                          }
                        }
                      ]
                }
                site.host

        in  own

--| Redirect-only hosts, rendered to their OWN file.
--
-- ⚠ Not decoration: `nginx.ingress.kubernetes.io/permanent-redirect` is
-- validated as a URL by the ingress admission webhook, and `$request_uri` is not
-- one — so a redirect carrying it is REFUSED on apply even though an identical
-- object created before the webhook gained that check is still running. Keeping
-- these in a separate manifest means one un-appliable document cannot block the
-- site it sits beside. See task #692.
let redirect
    : Site → List K.Ingress
    = λ(site : Site) →
        let issuer = toMap { `cert-manager.io/cluster-issuer` = "letsencrypt-prod" }

        let backend =
              λ(host : Text) →
                { host
                , http.paths =
                  [ { path = "/"
                    , pathType = "Prefix"
                    , backend.service = { name = site.name, port.number = 80 }
                    }
                  ]
                }

        in  L.map
                Redirect
                K.Ingress
                ( λ(r : Redirect) →
                    { apiVersion = "networking.k8s.io/v1"
                    , kind = "Ingress"
                    , metadata =
                        annotated
                          r.name
                          (   issuer
                            # toMap
                                { `nginx.ingress.kubernetes.io/permanent-redirect` =
                                    "https://${r.to}\$request_uri"
                                }
                          )
                    , spec =
                      { ingressClassName = "nginx"
                      , tls =
                        [ { hosts = [ r.host ], secretName = r.tlsSecret } ]
                      , rules = [ backend r.host ]
                      }
                    }
                )
                site.redirects

--| The declared-unowned filenames, one per line, for the generator's `--check`.
--  A fold rather than a Prelude import: this directory deliberately vendors the
--  two list helpers it needs instead of pulling a package over the network.
--| The host `scripts/apply.sh` deploys to, from the model rather than from
--  whoever is typing. See `Site.cluster`.
let clusterHost
    : Site → Text
    = λ(site : Site) →
        merge
          { isis = "isis.xinutec.org", amun = "amun.xinutec.org" }
          site.cluster

let netpolWaiver
    : Site → Bool
    = λ(site : Site) → site.netpolWaiver

let unownedFiles
    : Site → Text
    = λ(site : Site) →
        List/fold
          { file : Text, why : Text }
          site.unowned
          Text
          ( λ(u : { file : Text, why : Text }) →
            λ(acc : Text) →
              ''
              ${u.file}
              ${acc}''
          )
          ""

in  { Doc
    , Webroot
    , Overlay
    , Redirect
    , Site
    , nginxImage
    , nginxPort
    , webrootPath
    , storageWaiver
    , netpolWaiver
    , clusterHost
    , unownedFiles
    , configMaps
    , pvc
    , deployment
    , service
    , ingress
    , redirect
    }
