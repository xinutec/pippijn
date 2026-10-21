{-
frontdoor-unowned.dhall — hosts the cluster answers for that the MODEL DOES NOT
OWN, stated here so the front-door table is complete.

WHY THIS FILE EXISTS AND WHY IT IS SHORT. `generate.sh --check` compares each
app and site against its live tree, and `Site.unowned` / `T.Unowned` let a tree
declare a file the model does not render. Neither mechanism can see a tree that
has NO model file at all: `kubes/nextcloud/` is hand-written YAML with no entry
under `apps/`, so nothing compares it against anything and its hosts —
`dash.xinutec.org` among them — reach this table only by being counted by hand
(#1294).

⚠ **AN ENTRY HERE IS A DEBT, NOT A DESIGN.** Every row is a host whose front
door would be generated from a hand-written statement rather than from the thing
that actually deploys it, so the two can drift and only the check would notice.
The right end state for `nextcloud` is an `apps/nextcloud.dhall`; that is a
large job against a live Nextcloud with a database and a shared PVC, and it is
not a prerequisite for the front door. Writing the row costs a sentence and
buys a complete table today.

⚠ **THE CHECK IS WHAT MAKES THIS SAFE, and it runs in both directions.** A host
the cluster serves and this table lacks is a failure; a host this table names
and the cluster does not serve is also a failure. Without the second direction
these rows would rot silently the first time one of them was retired.

Every row comes from a live Ingress object on one of the two clusters.
-}
let F = ./lib/frontdoor.dhall

let dns = ./dns.dhall

let isis = "isis.xinutec.org"

let amun = "amun.xinutec.org"

in  [     F.default
      ⫽ { host = dns.dash
        , upstream = F.svcFqdn "nextcloud-server" "nextcloud"
        , -- VPN-only until the image carries PHP 8.5.12: CVE-2026-109618 and
          -- -109619 run code unauthenticated on 8.5.11, under attack.
          exposure = "VpnOnly"
        , clusters = [ isis ]
        , maxBodySize = Some "4096m"
        , readTimeout = Some 300
        , modelled = False
        , why =
            "kubes/nextcloud/ is hand-written YAML with no apps/ entry, so --check has never looked at it. Modelling Nextcloud means its database, shared PVC and redis too; the front door does not need that, and this row does."
        }
    ,     F.default
      ⫽ { host = dns.isis
        , path = "/share/share-cc58ab5c727c4a25"
        , upstream = F.svcFqdn "httpd-isis" "web"
        , exposure = "Public"
        , clusters = [ isis ]
        , basicAuth = Some "web/basic-auth"
        , modelled = False
        , why =
            "the second Ingress on isis.xinutec.org, already declared unowned in sites/isis.dhall as share-auth.yaml: it and its bcrypt Secret are git-crypt'd because this repository is public. Site.unowned names the FILE; the front door needs the ROUTE."
        }
    ,     F.default
      ⫽ { host = dns.mail
        , upstream = F.svcFqdn "mailu-front" "mailu-mailserver"
        , port = 443
        , scheme = "https"
        , exposure = "Public"
        , clusters = [ amun ]
        , modelled = False
        , why =
            "mailu is deployed from its own chart and has never been in this model. Its Ingress names the backend port by NAME (https), which resolves to 443, and carries backend-protocol: HTTPS — the only upstream in the fleet that is not plain http."
        }
    , -- The webmail behind a password until Mailu ships a PHP past 8.3.36:
      -- CVE-2026-109618 and -109619 run code unauthenticated on its 8.3.15.
      -- The mail ports are Mailu's own hostPorts and are not behind this.
          F.default
      ⫽ { host = dns.mail
        , path = "/webmail"
        , upstream = F.svcFqdn "mailu-front" "mailu-mailserver"
        , port = 443
        , scheme = "https"
        , exposure = "Public"
        , clusters = [ amun ]
        , basicAuth = Some "mailu-mailserver/webmail-auth"
        , modelled = False
        , why =
            "the same mailu-front as the row above, under a password while its webmail's PHP is unpatched; the Secret is git-crypt'd at kubes/mailu-mailserver/k8s/webmail-auth.yaml."
        }
    ] : List F.Entry
