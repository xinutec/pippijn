-- observe's fleet tier: a static nginx serving the runs ledger — published
-- reconstruction meshes (glTF) plus the before/after viewer page — to the phone
-- and any browser on the VPN. The Mac cannot be reached from the phone (one-way
-- VPN peer), so this mirror is how a scan becomes visible away from the Mac.
--
-- THE FIRST APP IN THE MODEL WITH NO APPLICATION BACKEND AT ALL, and that is
-- what it adds to the vocabulary. There is no image of ours, no port an app
-- listens on, no database — nginx serving two directories IS the deployment.
-- So its configuration cannot live in the environment the way every other app's
-- does: it is an nginx vhost, a file, and `T.ConfigMapDoc` exists for it.
--
-- It is also the first to mount a directory from the NODE. That is a real
-- exception and it is rendered as one: `DL-K8S-HOST-PATH` fires on it and the
-- generator emits the waiver from `why` below, so the reason travels with the
-- manifest instead of being lost between the model and the tree.
let T = ../lib/types.dhall

let contentPath = "/srv/observe"

let nginxConfName = "observe-viewer-nginx"

in  T.namespaceOf
      (     { name = "observe"
      , cluster = T.Cluster.isis
      , db = None T.Database
      , -- No PVC. The content is a hostPath the Mac rsyncs to; see `volumes`.
        storage = None T.Storage
      , configMap = Some
        { name = nginxConfName
        , files = toMap
            { `default.conf` =
                ''
                # The client activity trace, as one line per batch. `client-event` is the
                # string the whole fleet's traces are grepped by, so this tier answers to
                # the same search even though its "endpoint" is a log format rather than a
                # handler. The body is the batch, verbatim: the client caps and flattens
                # each label before sending, because nginx cannot.
                log_format telemetry 'client-event at=$time_iso8601 batch=$request_body';

                server {
                  listen 8091;
                  root /srv/observe/web;
                  autoindex off;

                  # Meshes are ~20-55 MB of glTF JSON; gzip makes the WireGuard transfer
                  # to the phone bearable. .gltf has no entry in nginx's mime.types, so it
                  # serves as application/octet-stream — hence that type in the list.
                  #
                  # text/javascript, not just application/javascript: nginx's own
                  # mime.types has served .js as text/javascript since 1.21.4, so the older
                  # type alone matched nothing and the viewer bundle (1.4 MB of Angular +
                  # model-viewer) went over the tunnel uncompressed.
                  gzip on;
                  gzip_min_length 1024;
                  gzip_types application/json model/gltf+json application/octet-stream
                             text/css text/javascript application/javascript;

                  location = /healthz {
                    return 200 "ok\n";
                  }

                  # The client activity trace. Unlike every other frontend in the fleet
                  # this tier has no application backend at all — nginx serving a hostPath
                  # is the whole deployment — so the endpoint has to be nginx itself.
                  #
                  # The self-proxy is the load-bearing part. `$request_body` is empty
                  # unless nginx actually READS the body, and for a static location it
                  # never does; passing the request upstream (to this server's own
                  # /healthz) is what makes it buffer one. Without it the log line would
                  # arrive faithfully every five seconds saying nothing.
                  #
                  # The events land in the pod's stdout beside the request log, which is
                  # where the rest of the fleet's `client-event` lines are read from.
                  location = /api/telemetry {
                    client_body_buffer_size 64k;
                    client_max_body_size 64k; # 50 events, each a path and a capped label
                    access_log /dev/stdout telemetry;
                    proxy_pass http://127.0.0.1:8091/_telemetry_sink;
                  }

                  # Where that self-proxy lands. It exists to be a name: the sink could just
                  # as well be /healthz, but then every open tab would put a health-probe
                  # line in the access log every five seconds and the log would be lying
                  # about what happened. Not `internal` — proxy_pass reaches this over TCP,
                  # like any other client, so `internal` would 404 it.
                  location = /_telemetry_sink {
                    return 204;
                  }

                  location /runs/ {
                    alias /srv/observe/runs/;
                  }

                  location / {
                    # Always revalidate: the WebView's heuristic caching showed stale
                    # pages, and a viewer that silently presents an OLD UI as current is
                    # the one failure worth paying a round trip per load to avoid. The
                    # bundle's filenames are content-hashed, so a revalidation is a cheap
                    # 304 whenever nothing was republished.
                    # Meshes under /runs/ keep heuristic caching: run dirs are immutable.
                    add_header Cache-Control "no-cache";
                    try_files $uri $uri/ =404;
                  }
                }
                ''
            }
        }
      , workload =
        { -- No Ingress and no DNS record, the same stance as recall and scanner:
          -- the shared nginx ingress answers on isis's PUBLIC address whatever DNS
          -- says, so an Ingress here would be obscurity rather than a gate. These
          -- are reconstructions of rooms in the house.
          reach = T.Reach.WireGuard
        , name = "observe-viewer"
        , -- Third-party and PINNED to a tag, as `Upstream` requires. The
          -- unprivileged variant specifically: it listens on 8091 as uid 101
          -- without ever being root, which is what lets the pod satisfy
          -- runAsNonRoot at all.
          image =
            T.Image.Upstream
              { repo = "docker.io/nginxinc/nginx-unprivileged", tag = "alpine" }
        , command = None (List Text)
        , port = 8091
        , uid = 101
        , hardening = T.Hardening.NonRoot
        , readOnlyRootFs = True
        , env = [] : List T.EnvVar
        , probeTiming =
            -- Its own, for the reason scanner's is: nginx is ready in about a
            -- second, and an app reached by a hostPort cannot roll, so every
            -- second of readiness delay is a second of downtime per deploy.
            { readiness = { initialDelaySeconds = 2, periodSeconds = 10 }
            , liveness = { initialDelaySeconds = 5, periodSeconds = 30 }
            }
        , probe = T.Probe.Http { path = "/healthz", port = 8091 }
        , resources =
          { requests = { cpu = "50m", memory = "32Mi" }
          , limits = Some { cpu = Some "1", memory = "256Mi" }
          }
        , volumes =
          [ { name = "content"
            , source =
                T.VolumeSource.HostPath
                  { path = contentPath
                  , why =
                      "a disposable mirror the Mac rsyncs to (scripts/publish_run.sh); a local-path PVC's opaque path would break that publish for no gain on one node"
                  }
            }
          , { name = "nginx-conf"
            , source = T.VolumeSource.ConfigMap { name = nginxConfName }
            }
          , { name = "tmp", source = T.VolumeSource.EmptyDir }
          ]
        , mounts =
          [ { name = "content"
            , mountPath = contentPath
            , subPath = None Text
            , -- The Mac owns this directory. A pod that could write it would be
              -- a second author of a tree whose next `rsync --delete` is
              -- authoritative, so the write would vanish without a trace.
              readOnly = True
            }
          , { name = "nginx-conf"
            , mountPath = "/etc/nginx/conf.d"
            , subPath = None Text
            , readOnly = True
            }
          , { name = "tmp"
            , mountPath = "/tmp"
            , subPath = None Text
            , -- nginx-unprivileged keeps its pid and temp files here, which is
              -- the whole reason a read-only root filesystem works at all.
              readOnly = False
            }
          ]
        , tasks = [] : List T.ScheduledTask
        }
      , secrets = [] : List T.SecretKey
      , -- Default-deny egress with no exceptions: it serves static files and
        -- makes no outbound call at all, not even DNS. Egress-only because k3s
        -- enforces policy through kube-router, which does not exempt
        -- node-sourced kubelet probes — a default-deny INGRESS would drop them
        -- and take the pod NotReady.
        netpol = T.Netpol.Egress ([] : List T.EgressTo)
      }
          : T.App
      )
