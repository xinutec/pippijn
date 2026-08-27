let S =
      -- slides.xinutec.org — password-gated static host for the Marp talk decks.
      --
      -- Standalone on purpose: its own Deployment, ConfigMap, PVC and Service, sharing
      -- nothing with `httpd-isis` (the dicom-scan share). A change or an outage there
      -- cannot affect slides, and vice versa.
      --
      -- Decks live at the webroot root (`/usr/share/nginx/html/<deck>/`) and are served
      -- at the public root (`slides.xinutec.org/<deck>/`) with NO path rewrite, so
      -- nginx's directory trailing-slash redirect stays in public terms. Combined with
      -- `absolute_redirect off`, the bare `/<deck>` 301 becomes a relative `/<deck>/`
      -- and never leaks the internal :8080 listen port or a `/share/...` path.
      ../lib/site.dhall

let T = ../lib/types.dhall

let dns = ../dns.dhall

in    { name = "slides"
      , cluster = T.Cluster.isis
      , slug = "slides"
      , host = Some dns.slides
      , replicas = 1
      , webroot = S.Webroot.Volume
        { storageGi = 1
        , -- The decks are built from `~/Code/slides` and pushed by its
          -- `deploy.sh`, so a lost claim is recovered by one re-deploy rather
          -- than by a restore. Rendered as the waiver on the claim.
          durability = T.Durability.LossAccepted
            { why =
                "derived content — re-pushed from ~/Code/slides via deploy.sh, so a lost PVC is recovered by one re-deploy, not a restore."
            }
        , at = ""
        }
      , overlays = [] : List S.Overlay
      , nginxConf = Some
          ''
          server {
              listen 8080;
              server_name _;
              root /usr/share/nginx/html;
              index index.html;

              # Directory 301 (/<deck> -> /<deck>/) stays relative, so it never leaks
              # the internal listen port or path into the Location header.
              absolute_redirect off;

              # Kubelet readiness — bypasses the ingress auth layer, so it must not
              # require a password.
              location = /healthz {
                  access_log off;
                  add_header Content-Type text/plain;
                  return 200 "ok\n";
              }
          }
          ''
      , -- Independent of the dicom-scan share's `web/basic-auth`: a leak of one
        -- is not a leak of the other. Username `pippijn`.
        auth = Some "web/slides-auth"
      , -- NOT `/`, which the auth annotations above would gate: kubelet presents
        -- no credentials, so a probe on `/` marks every pod NotReady and takes
        -- the site down. The nginx conf answers this one before auth.
        probePath = "/healthz"
      , -- amun carries it for the shared `web` namespace; see its model.
        netpolWaiver = False
      , redirects = [] : List S.Redirect
      , unowned =
        [ { file = "auth.yaml"
          , why =
              "the basic-auth Secret: a bcrypt password hash, git-crypt'd, and this repository is public"
          }
        ]
      }
    : S.Site
