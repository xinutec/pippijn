let S =
      -- isis.xinutec.org — the file share, served from a PVC under `/share`.
      --
      -- The webroot claim mounts at `${webroot}/share` rather than at the root, so the
      -- image's own index still answers `/` and only the share directory is this
      -- volume's. Content is pushed from `~/Code/dicom-scan`.
      --
      -- ⚠ Two Ingresses serve this host and only one is modelled here. The other,
      -- `isis-share-auth`, lives in `share-auth.yaml` with the bcrypt Secret it
      -- references — git-crypt'd, because this repository is public — and is declared
      -- `unowned` below so `--check` neither renders nor forgets it.
      ../lib/site.dhall

let T = ../lib/types.dhall

let dns = ../dns.dhall

in    { name = "httpd-isis"
      , cluster = T.Cluster.isis
      , slug = "isis"
      , host = Some dns.isis
      , replicas = 2
      , webroot = S.Webroot.Volume
        { storageGi = 5
        , -- Published copies of documents whose originals live in
          -- `~/Code/dicom-scan`; a lost claim is re-pushed, not restored.
          durability = T.Durability.LossAccepted
            { why =
                "published copies — the originals live in ~/Code/dicom-scan and are re-pushed, so a lost PVC costs a re-deploy, not a restore."
            }
        , at = "/share"
        }
      , overlays = [] : List S.Overlay
      , nginxConf = Some
          ''
          server {
              listen 8080;
              server_name _;
              root /usr/share/nginx/html;
              index index.html;

              location ~ \.(md|py|sh)$ {
                  default_type text/plain;
              }

              # Slice images for the DICOM viewer: thousands of small files,
              # each one a request, and every request on this host re-runs
              # basic auth. Without a Cache-Control header browsers fall back
              # to heuristic freshness and revalidate constantly, paying that
              # cost again. The images are derived from archived studies and
              # only change when they are deliberately re-exported.
              # Deliberately NOT `immutable`: a re-export should still reach a
              # reader who reloads, rather than being pinned for a whole day.
              location ~* ^/share/[^/]+/slices/.+\.webp$ {
                  add_header Cache-Control "public, max-age=86400";
              }
          }
          ''
      , -- The auth-gated route is the OTHER Ingress; this one is open, and the
        -- share's own directory listing is what it serves.
        auth = None Text
      , probePath = "/"
      , -- amun carries it for the shared `web` namespace; see its model.
        netpolWaiver = False
      , redirects = [] : List S.Redirect
      , unowned =
        [ { file = "share-auth.yaml"
          , why =
              "a bcrypt Secret and the auth-gated Ingress that references it, git-crypt'd because this repository is public"
          }
        ]
      }
    : S.Site
