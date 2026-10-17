{-
`overpass` — our own Overpass API over an England extract, for health's OSM
mirrors (task #2013).

The public instances are not dependable: in 2026-10 `overpass.kumi.systems`,
`overpass.private.coffee` and `maps.mail.ru` all failed, and `overpass-api.de`
refused a third or more of the rail-stops tiles with 502/429, so the refresh
fell below its coverage floor two days running.

ENGLAND, not the home region: rail routes are fetched whole by relation, and a
long ride's relation runs far outside London.

The database is built from the Geofabrik extract on first start (`/db/init_done`
marks it built; hours, and the pod is unready until then) and kept current from
Geofabrik's daily diffs.
-}

let T = ./../lib/types.dhall

let port = 80

let lit = T.EnvValue.Literal

let db =
      T.Claim::{
      , name = "overpass-db"
      , storageGi = 60
      , durability =
          T.Durability.LossAccepted
            { why =
                "a derived index of the public Geofabrik England extract: rebuilt by deleting the claim and starting the pod"
            }
      , -- Overpass's dispatcher holds the database alone.
        writers = T.Writers.Exclusive
      , -- No fsGroup to apply: the entrypoint chowns.
        chown = T.FsGroupChange.Always
      }

in  { name = "overpass"
    , owner = T.Owner.Own
    , labels = [] : T.Labels
    , placement = T.on T.Cluster.isis
    , db = None T.Database
    , configMap = None T.ConfigMapDoc
    , claims = [ db ]
    , secrets = [] : List { mapKey : Text, mapValue : Text }
    , origins = [] : List { mapKey : Text, mapValue : T.Origin }
    , unowned = [] : List T.Unowned
    , -- health's refresh jobs are the only clients.
      netpol =
        T.Netpol.Ingress
          [ { to = [ T.NetpolPeer.Namespace "health" ]
            , ports = [ { port, protocol = "TCP" } ]
            }
          ]
    , acme = None T.AcmeDelegation
    , tree = None Text
    , workloads =
      [ T.Workload::{
        , name = "overpass"
        , reach = T.Reach.Internal
        , image =
            T.Image.Upstream
              { repo = "wiktorn/overpass-api", tag = "v0.7.62.11" }
        , port
        , uid = 0
        , selector = T.Selector.App
        , hardening =
            T.Hardening.Unhardened
              { why =
                  "third-party image whose entrypoint runs as root: it chowns /db to its overpass user, renders /etc/nginx/nginx.conf and starts supervisord"
              }
        , rootFs =
            T.RootFs.Writable
              { why =
                  "the entrypoint writes /etc/nginx/nginx.conf and /dev/shm at every start"
              }
        , volumeOwnership =
            T.VolumeOwnership.EntrypointChowns
              { why = "docker-entrypoint.sh chowns /db/* to overpass" }
        , env =
          [ { name = "OVERPASS_MODE", value = lit "init" }
          , { name = "OVERPASS_PLANET_URL"
            , value =
                lit
                  "https://download.geofabrik.de/europe/united-kingdom/england-latest.osm.pbf"
            }
          , { name = "OVERPASS_DIFF_URL"
            , value =
                lit
                  "https://download.geofabrik.de/europe/united-kingdom/england-updates/"
            }
          , -- The init reads .osm.bz2; this is the README's Geofabrik recipe.
            { name = "OVERPASS_PLANET_PREPROCESS"
            , value =
                lit
                  "osmium cat -o /db/planet.osm.bz2 /db/planet.osm.pbf && rm /db/planet.osm.pbf"
            }
          , -- Geofabrik publishes one diff a day.
            { name = "OVERPASS_UPDATE_SLEEP", value = lit "3600" }
          , -- No query asks for metadata or areas.
            { name = "OVERPASS_META", value = lit "no" }
          , { name = "OVERPASS_USE_AREAS", value = lit "false" }
          , { name = "OVERPASS_COMPRESSION", value = lit "gz" }
          , -- Serve straight after the build rather than exit and be restarted.
            { name = "OVERPASS_STOP_AFTER_INIT", value = lit "false" }
          , -- A refused tile is retried with the same query.
            { name = "OVERPASS_ALLOW_DUPLICATE_QUERIES", value = lit "yes" }
          ]
        , probeTiming =
            { readiness = { initialDelaySeconds = 30, periodSeconds = 30 }
            , -- None: the first start builds the database for hours with nothing
              -- listening, and a liveness probe would restart the build.
              liveness =
                None { initialDelaySeconds : Natural, periodSeconds : Natural }
            , startup = None T.StartupTiming
            }
        , probe = T.Probe.Http { path = "/api/status", port }
        , resources = Some
          { requests = { cpu = "100m", memory = "512Mi" }
          , limits = Some { cpu = None Text, memory = "4Gi" }
          }
        , volumes = [ { name = "db", source = T.VolumeSource.Claim db } ]
        , mounts =
          [ { name = "db", mountPath = "/db", subPath = None Text, readOnly = False }
          ]
        }
      ]
    }
  : T.Namespace
