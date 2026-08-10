-- sinterklaas.xinutec.org — the Sinterklaas drawing, for one December.
--
-- The simplest site of the four: no volume, no nginx config, no auth, no
-- redirect. Everything it serves is two files in a ConfigMap, so a change is a
-- re-render rather than a push to a webroot somebody has to remember to make.
--
-- The content lives in `content/sinterklaas.dhall`, which is git-crypt'd. That
-- split is deliberate: the shape of the site is worth reviewing in the open, and
-- the names and wishlists of six people are not worth handing to a search index.
-- ⚠ If this model ever inlines that import, add the `.gitattributes` line to
-- whatever file the content lands in, or the encryption is undone by a refactor
-- rather than by a decision. Task #691 has the history.
let S = ../lib/site.dhall

let dns = ../dns.dhall

in    { name = "httpd-sinterklaas"
      , slug = "sinterklaas"
      , host = Some dns.sinterklaas
      , replicas = 2
      , webroot = S.Webroot.Config { files = ./content/sinterklaas.dhall }
      , overlays = [] : List S.Overlay
      , nginxConf = None Text
      , auth = None Text
      , -- The page itself; there is no `/healthz` because there is no server to
        -- write one, only nginx serving a directory.
        probePath = "/"
      , -- amun carries it for the shared `web` namespace; see its model.
        netpolWaiver = False
      , redirects = [] : List S.Redirect
      , unowned = [] : List { file : Text, why : Text }
      }
    : S.Site
