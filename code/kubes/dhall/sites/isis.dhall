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
let S = ../lib/site.dhall

let T = ../lib/types.dhall

let dns = ../dns.dhall

in    { name = "httpd-isis"
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
