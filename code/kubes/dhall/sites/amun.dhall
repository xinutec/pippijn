-- amun.xinutec.org — the main site, and the apex `xinutec.org` with it.
--
-- The site itself is the stock nginx welcome page: nothing here serves content
-- of its own, which is why the webroot is `Stock`. What it exists for is the one
-- file overlaid under `.well-known/` — Android's Digital Asset Links, which is
-- what lets health.xinutec.org links open in the app instead of a browser tab.
-- Mounted by `subPath`, so it lands beside the image's own files rather than
-- replacing the directory.
let S = ../lib/site.dhall

let dns = ../dns.dhall

in    { name = "httpd-amun"
      , slug = "amun"
      , host = Some dns.amun
      , replicas = 2
      , webroot = S.Webroot.Stock
      , overlays =
        [ { name = "assetlinks-config"
          , path = "/.well-known/assetlinks.json"
          , file =
            { mapKey = "assetlinks.json"
            , mapValue =
                ''
                [{
                  "relation": ["delegate_permission/common.handle_all_urls"],
                  "target": {
                    "namespace": "android_app",
                    "package_name": "org.xinutec.health",
                    "sha256_cert_fingerprints":
                    ["FF:2A:CF:7B:DD:CC:F1:03:3E:E8:B2:27:7C:A2:E3:3C:DE:13:DB:AC:8E:EB:3A:B9:72:A1:0E:26:8A:F5:EC:AF"]
                  }
                }]
                ''
            }
          }
        ]
      , nginxConf = None Text
      , auth = None Text
      , probePath = "/"
      , -- ⚠ THIS site carries the `web` namespace's waiver, and it must be
        -- exactly one of the four. `DL-K8S-NP-DEFAULT-DENY` anchors on the FIRST
        -- Deployment in a namespace; all four sites share `web`, so a second
        -- waiver would waive nothing and dev-lint fails an ineffective waiver.
        netpolWaiver = True
      , redirects =
        [ { name = "xinutec-apex-redirect"
          , -- The apex has no app of its own. Without an Ingress the shared
            -- controller answers :443 with its own fake certificate, which is
            -- what a browser reports — so this exists to hold a real one and to
            -- send the visitor where the site actually lives.
            host = dns.domain
          , to = dns.amun
          , tlsSecret = "xinutec-apex-tls"
          }
        ]
      , unowned = [] : List { file : Text, why : Text }
      }
    : S.Site
