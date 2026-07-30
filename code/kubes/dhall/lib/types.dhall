-- The typed fleet model.
--
-- This file is the schema every app is written against. The point of putting
-- it in Dhall rather than YAML is that the invariants below stop being things
-- a linter re-derives after the fact and start being things the type checker
-- refuses to let you write:
--
--   * a fleet image cannot carry a version tag (see `Image`)
--   * an env var is either a literal or a secret reference, never ambiguous
--   * a secret key is a *record field*, so a typo is a type error, not a pod
--     that boots with an empty password (see `apps/*.dhall`)
--   * a container must state its resource limits
--
-- Nothing here performs IO. Rendering a manifest is pure evaluation, which is
-- why `generate.sh --check` can be trusted as a dry run.

--| Which k3s cluster an app is scheduled on.
let Cluster = < isis | amun >

--| A container image.
--
-- `Fleet` deliberately has no tag field. Every image we build is published as
-- `xinutec/<name>:latest` and rolled forward by restarting the deployment; a
-- version- or digest-pinned fleet deploy is not expressible in this model, so
-- it cannot be reintroduced by copy-paste. Third-party images DO pin, because
-- an unpinned `mariadb` would silently major-upgrade a database.
let Image = < Fleet : Text | Upstream : { repo : Text, tag : Text } >

let imageRef
    : Image → Text
    = λ(i : Image) →
        merge
          { Fleet = λ(name : Text) → "xinutec/${name}:latest"
          , Upstream = λ(u : { repo : Text, tag : Text }) → "${u.repo}:${u.tag}"
          }
          i

--| Where an environment variable's value comes from.
let EnvValue = < Literal : Text | FromSecret : { key : Text, optional : Bool } >

let EnvVar = { name : Text, value : EnvValue }

--| How kubelet decides the container is alive.
--
-- The probe *timings* are not part of this type on purpose: they are a
-- property of the workload kind, not of the app, and the renderer supplies one
-- reviewed set for all of them.
let Probe =
      < Http : { path : Text, port : Natural } | Exec : { command : List Text } >

let Quantity = { cpu : Text, memory : Text }

--| Both halves are required. A container with requests but no limits is the
--  state `DL-K8S-NO-MEM-LIMIT` exists to catch; here it does not typecheck.
let Resources = { requests : Quantity, limits : Quantity }

let VolumeMount = { name : Text, mountPath : Text, subPath : Text }

--| A persistent volume the app's *own* container writes to.
--
-- Distinct from a `Database`'s storage, which the engine owns and the app never
-- touches. Most fleet apps keep their state in a database and want none of
-- this, which is why it is optional — but one of them (utterance) stores
-- uploaded recordings and the voiceprints derived from them as files, and a
-- pod with no volume loses both on every restart.
--
-- Size, path and subdirectory are one value rather than three, so the PVC, the
-- pod's volume and the container's mount are all rendered from the same
-- declaration. Stated as a `VolumeMount` on the workload instead, a mount could
-- name a volume nobody created — which kubelet reports as a pod stuck in
-- `ContainerCreating` with the reason several layers down in an event.
--
-- `subPath` for the same reason MariaDB uses one: a volume's root can come with
-- filesystem furniture (`lost+found` on ext4), and code that lists its data
-- directory should not have to know that.
let Storage = { storageGi : Natural, mountPath : Text, subPath : Text }

--| A long-running container plus the Service in front of it.
let Workload =
      { name : Text
      , image : Image
      , command : Optional (List Text)
      , port : Natural
      , uid : Natural
      , readOnlyRootFs : Bool
      , env : List EnvVar
      , probe : Probe
      , resources : Resources
      , mounts : List VolumeMount
      }

--| A MariaDB sidecar database. The engine version lives in `render.dhall`, so
--  a fleet-wide major bump is one edit instead of six identical ones.
--
-- `keys` names the three secret entries the engine needs. They are supplied by
-- the app (from its declared secret record) rather than hardcoded here, so the
-- keys MariaDB reads and the keys `secret.sh` writes are the same expressions.
let Database =
      { dbName : Text
      , storageGi : Natural
      , resources : Resources
      , keys : { user : Text, password : Text, rootPassword : Text }
      }

--| How the internet sees an app's hostname, and therefore how its certificate
--  can be issued.
--
-- `Public` resolves to the node's public address, so Let's Encrypt can reach it
-- and HTTP-01 works. `VpnOnly` resolves to the WireGuard address instead — the
-- record exists, but nothing outside the tunnel can complete an HTTP challenge,
-- so the certificate must come from DNS-01.
--
-- This is one field rather than two because the issuer is not an independent
-- choice: pairing HTTP-01 with a VPN-only name yields a certificate stuck
-- pending forever, and the failure surfaces as a browser TLS error days later.
-- Naming the exposure makes the issuer follow from it.
--
-- ⚠ VpnOnly is obscurity at the DNS layer, not a firewall — the ingress still
-- answers on the public IP for anyone who knows it. The app's own sign-in wall
-- is the real gate.
let Exposure = < Public | VpnOnly >

let issuerFor
    : Exposure → Text
    = λ(e : Exposure) →
        merge { Public = "letsencrypt-prod", VpnOnly = "letsencrypt-dns" } e

--| A declared secret key. `apps/*.dhall` builds a record of these and refers to
--  its fields, which is how a mistyped key becomes a compile error.
let SecretKey = { mapKey : Text, mapValue : Text }

let App =
      { name : Text
      , cluster : Cluster
      , db : Optional Database
      , storage : Optional Storage
      , workload : Workload
      , host : Optional Text
      , exposure : Exposure
      , secrets : List SecretKey
      , netpol : Bool
      }

in  { Cluster
    , Image
    , imageRef
    , EnvValue
    , EnvVar
    , Probe
    , Quantity
    , Resources
    , VolumeMount
    , Storage
    , Workload
    , Database
    , SecretKey
    , Exposure
    , issuerFor
    , App
    }
