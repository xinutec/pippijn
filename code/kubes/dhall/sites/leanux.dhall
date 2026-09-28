let S =
      -- leanux.org — the public page for Leanux, the phone OS (repo: xinutec/phonos).
      --
      -- Public, no password: this is the one site here meant for strangers. The same
      -- standalone shape as `slides` — its own Deployment, ConfigMap, PVC and Service —
      -- and the content is pushed by `scripts/site.py deploy` in the OS repo, which
      -- builds `site/` and replaces the webroot wholesale.
      ../lib/site.dhall

let T = ../lib/types.dhall

let dns = ../dns.dhall

in    { name = "leanux"
      , cluster = T.Cluster.isis
      , slug = "leanux"
      , host = Some dns.leanux
      , replicas = 1
      , webroot = S.Webroot.Volume
        { storageGi = 1
        , durability = T.Durability.LossAccepted
            { why =
                "derived content — rebuilt from site/ in the OS repo and re-pushed by scripts/site.py deploy, so a lost PVC costs a re-deploy, not a restore."
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

              # Directory 301s stay relative, so they never leak the internal
              # listen port into the Location header.
              absolute_redirect off;

              location = /healthz {
                  access_log off;
                  add_header Content-Type text/plain;
                  return 200 "ok\n";
              }
          }
          ''
      , auth = None Text
      , probePath = "/healthz"
      , netpolWaiver = False
      , redirects =
        [ { name = "leanux-www-redirect"
          , host = dns.leanuxWww
          , to = dns.leanux
          , tlsSecret = "leanux-www-tls"
          }
        ]
      , unowned = [] : List { file : Text, why : Text }
      }
    : S.Site
