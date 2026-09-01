{-
lib/frontdoor.dhall — every hostname the fleet answers, as DATA.

WHAT THIS IS FOR. `render.dhall` and `site.dhall` already know each host, but
only as a field buried inside a rendered Ingress. Nothing could ask the model
"what does isis serve?" without parsing YAML it had just produced. That question
has two consumers now: the host-nginx front door #1294 replaces the archived
ingress-nginx with, and the check that the model still describes the live
cluster.

⚠ RENDERS NO MANIFEST BYTE. Same standing as `clusterHosts` and `treeOf`: it is
evaluated into `frontdoor.json` by `generate.sh`, and read from there. Adding a
field here cannot change what is deployed.

⚠ **`modelled` IS THE HONEST PART OF THIS FILE.** The table has to be COMPLETE
to be worth anything — a front door generated from an incomplete list silently
drops a host, which is an outage that looks like a DNS problem. But the model
does not own every tree in the cluster: `kubes/nextcloud/` is hand-written YAML
with no app file, so `generate.sh --check` has never looked at it, and
`dash.xinutec.org` was invisible to the model until it was counted by hand on
2026-09-01. So entries come from two places and say which they are, and the
check compares the union against the live cluster in BOTH directions. A host in
the cluster and not in this table is a failure; a host here and not in the
cluster is also a failure. That is what makes an exception a declaration rather
than a hole.
-}
let Entry =
      { host :
          --| The name a client asks for. One host may appear more than once —
          --  `isis.xinutec.org` is served by two Ingresses, `/` and the share
          --  path — so this is NOT a key.
          Text
      , path :
          --| Prefix, matching the Ingress `pathType: Prefix` every rule uses.
          Text
      , upstream :
          --| The cluster-internal name to proxy to, fully qualified.
          --
          -- ⚠ **A NAME, NEVER A ClusterIP.** CoreDNS answers `cluster.local`
          --  with TTL 5 (measured on isis, 2026-09-01), so nginx re-resolves
          --  within five seconds of a Service being recreated. An emitted
          --  ClusterIP is a fact that stops being true the moment kubectl
          --  recreates the Service, and stays wrong until a human re-renders.
          Text
      , port : Natural
      , scheme :
          --| `"http"` or `"https"` — how the front door talks to the UPSTREAM,
          --  which is not how the client talks to the front door.
          --
          -- ⚠ Almost always `"http"`: TLS terminates at the front door and the
          --  hop to a ClusterIP stays inside the cluster network. `mailu` is the
          --  exception, and it is a real one rather than an oversight — its live
          --  Ingress carries `nginx.ingress.kubernetes.io/backend-protocol:
          --  HTTPS` because `mailu-front` serves the admin UI on 443 only.
          Text
      , exposure :
          --| `"Public"` or `"VpnOnly"`, as Text so this survives to JSON.
          --
          -- ⚠ Sites have no `Exposure` field, so all three render `"Public"`.
          --  That is an ASSUMPTION about the model, not a measurement, and it
          --  is checkable rather than believed: the live `cluster-issuer` is
          --  `letsencrypt-prod` for a public name and `letsencrypt-dns` for a
          --  VPN-only one, so the check reads the issuer back and fails if a
          --  site ever stops being public.
          Text
      , clusters :
          --| Which cluster hosts serve this. A LIST for the same reason
          --  `clusters.json`'s values are: `web` is placed on both.
          List Text
      , maxBodySize : Optional Text
      , readTimeout :
          --| Seconds. Only `dash` sets one, and `dash` is an unowned entry —
          --  no modelled workload has needed it, so `T.Workload` has no such
          --  field and inventing one would be a claim nothing checks.
          Optional Natural
      , basicAuth :
          --| `"<namespace>/<secret>"`, naming an existing Secret.
          Optional Text
      , redirectTo :
          --| Set when this host only redirects and proxies nothing.
          --
          -- ⚠ **`upstream` IS `""` ON EXACTLY THESE ROWS**, and a consumer must
          --  branch on this field rather than on an empty string. A redirect
          --  still needs its row: without one it has no certificate, and the
          --  shared controller answers :443 with its own fake one — which is
          --  what a browser reports. `xinutec.org` on amun is the only one.
          Optional Text
      , modelled :
          --| False for an entry declared in `frontdoor-unowned.dhall` because
          --  the model does not own its tree. See the header.
          Bool
      , why :
          --| Empty for a modelled entry. An unowned one must say why it is not
          --  modelled — the same discipline `T.Durability` and `Site.unowned`
          --  already impose, where taking the escape hatch costs a sentence.
          Text
      }

let default =
      --| Everything an ordinary modelled entry does not have to repeat.
      { path = "/"
      , port = 80
      , scheme = "http"
      , redirectTo = None Text
      , maxBodySize = None Text
      , readTimeout = None Natural
      , basicAuth = None Text
      , modelled = True
      , why = ""
      }

let svcFqdn
    : Text → Text → Text
    =
      --| `<service>.<namespace>.svc.cluster.local`. One place, so the front
      --  door and the check cannot spell it differently.
      λ(service : Text) → λ(namespace : Text) → "${service}.${namespace}.svc.cluster.local"

in  { Entry, default, svcFqdn }
