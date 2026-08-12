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
-- `Local` is the third case and the awkward one: an image built ON the node with
-- nix and imported straight into containerd, for a repo that has no CI and no
-- registry because its test data is private. It is NOT on Docker Hub, so a pull
-- would reach whatever stranger holds that name — which is why it is a
-- constructor rather than an `Upstream` with a `:local` tag. Carrying its own
-- `imagePullPolicy: Never` is the whole point: the two must not be separable.
let Image =
      < Fleet : Text
      | Upstream : { repo : Text, tag : Text }
      | Local : Text
      >

let imageRef
    : Image → Text
    = λ(i : Image) →
        merge
          { Fleet = λ(name : Text) → "xinutec/${name}:latest"
          , Upstream = λ(u : { repo : Text, tag : Text }) → "${u.repo}:${u.tag}"
          , Local = λ(name : Text) → "docker.io/xinutec/${name}:local"
          }
          i

--| Never, for a `Local` image; the cluster's own default for anything else.
--
-- Derived rather than declared, so "hand-imported" and "do not pull" cannot come
-- apart. A `Local` image whose policy was left at the default pulls on the first
-- restart after the node reboots, fails, and takes the app down at the moment
-- nobody is watching.
let pullPolicyFor
    : Image → Optional Text
    = λ(i : Image) →
        merge
          { Fleet = λ(_ : Text) → None Text
          , Upstream = λ(_ : { repo : Text, tag : Text }) → None Text
          , Local = λ(_ : Text) → Some "Never"
          }
          i

--| Where an environment variable's value comes from.
let EnvValue = < Literal : Text | FromSecret : { key : Text, optional : Bool } >

let EnvVar = { name : Text, value : EnvValue }

--| How kubelet decides the container is alive. The timings are `ProbeTiming`
--  below; this is only the question being asked.
let Probe =
      < Http : { path : Text, port : Natural }
      | Exec : { command : List Text }
      | --| Just "is anything listening". For a server that has no health
        --  endpoint, which is honest about what is actually being checked.
        Tcp : { port : Natural }
      >

--| How often kubelet asks, and how long it waits first.
--
-- This USED to be literals in the renderer, on the argument that the timings are
-- a property of the workload kind rather than of the app. That held while every
-- modelled app was a web service behind an Ingress. It stopped holding at the
-- three tunnel-only apps, which start in two to three seconds and want to be
-- marked ready in that time rather than in five — and, being reached by a
-- hostPort that cannot roll, spend that delay as downtime on every deploy.
--
-- Required rather than optional, and `standardTiming` is one definition: an app
-- says which set it uses and a reader can see it, but there is still exactly one
-- place the fleet default is written down.
let ProbeTiming =
      { readiness : { initialDelaySeconds : Natural, periodSeconds : Natural }
      , liveness : { initialDelaySeconds : Natural, periodSeconds : Natural }
      }

--| The reviewed set the renderer used to hardcode for everything.
let standardTiming
    : ProbeTiming
    = { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
      , liveness = { initialDelaySeconds = 15, periodSeconds = 20 }
      }

let Quantity = { cpu : Text, memory : Text }

--| Both halves are required. A container with requests but no limits is the
--  state `DL-K8S-NO-MEM-LIMIT` exists to catch; here it does not typecheck.
let Resources = { requests : Quantity, limits : Quantity }

--| A database engine's resources, where `limits` is Optional — and this is the
--  ONLY place in the model where it is.
--
-- Not a softening of the rule above. dev-lint's `image_profile` already sets
-- `require_memory_limit = false` for every `is_db` container fleet-wide, on the
-- stated grounds that "DB pools can be large and variable", so an unlimited
-- database is the linter's own considered position rather than an omission it
-- would catch. This type says the same thing where the manifest is written.
--
-- ⚠ It exists because health-db could not be modelled without it. That database
-- is ~4 GB with a 2 GB pool and its manifest argues the case explicitly: "a hard
-- cap risks an OOM-kill mid-query". The alternative was inventing a memory limit
-- on the largest database in the fleet so a type would accept it — which is the
-- model changing production to flatter itself, the exact failure `k8s.dhall`
-- names about `Container.resources`.
--
-- `Some` is still available and five of the six modelled databases use it. The
-- Optional buys the ONE case that is argued, not a default anybody can drift
-- into: omitting limits takes a `None` written on purpose.
let DbResources = { requests : Quantity, limits : Optional Quantity }

--| `readOnly` is stated, not defaulted. A content mirror the app must never
--  write and a scratch directory it must are the same three fields otherwise,
--  and only one of them is safe to get wrong quietly.
--
-- `subPath` is Optional and that is a DATA-SAFETY property, not tidiness: a
-- mount that gains one stops seeing the volume's root and starts seeing an
-- empty child. To the app that is indistinguishable from its data having been
-- lost. So a mount that has none must be able to say so rather than being given
-- one to satisfy the type.
let VolumeMount =
      { name : Text
      , mountPath : Text
      , subPath : Optional Text
      , readOnly : Bool
      }

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
--| What happens to an app's own volume when the cluster is restored from
--  backup. Required, so that declaring storage forces an answer: a volume whose
--  durability nobody stated is one nobody will miss until a restore.
let Durability =
      < --| A backup-prepare.sh block copies it. dev-lint's PVC ⊗ backup join
        --  checks that claim across the whole fleet, so stating it here without
        --  writing the block is caught rather than believed.
        BackedUp
      | --| Losing it is acceptable, and `why` says why. Emitted as the waiver on
        --  the rendered claim, where the finding is.
        LossAccepted : { why : Text }
      >

--| May two pods hold this volume at once?
--
-- Beside `durability` because both are questions a volume forces you to answer,
-- and neither is derivable from the manifest: this one is a fact about how the
-- app WRITES. `Exclusive` renders `strategy: Recreate`, so a rolling update
-- never overlaps two instances.
--
-- ⚠ Atomic writes do not answer it. Both apps here write-then-rename now (#744),
-- which stops a reader seeing a half-written file — and does nothing at all
-- about two pods each holding their own copy of a whole document, where the one
-- that renames last simply erases the other's update.
--
-- `Concurrent` carries `why` and `Exclusive` does not, deliberately: the safe
-- answer is free and the permissive one has to be argued. Only the apps that
-- declare their OWN storage answer this — five of the seven modelled apps keep
-- their state in a database and never reach it.
let Writers =
      < --| One pod at a time. The volume holds a document the pod rewrites
        --  whole, so a second instance's stale copy would overwrite the first's
        --  work rather than merge with it.
        Exclusive
      | --| Two at once is safe, and `why` says why it is safe HERE.
        Concurrent : { why : Text }
      >

let Storage =
      { storageGi : Natural
      , mountPath : Text
      , -- Optional for the reason `VolumeMount.subPath` is — adding one to a
        -- live mount hides the data that was there.
        subPath : Optional Text
      , durability : Durability
      , writers : Writers
      }

--| A volume that is NOT the app's own persistent claim.
--
-- `Storage` stays separate and keeps carrying `Durability`, because the question
-- "what happens to this on a restore" is real for a PVC and vacuous for the
-- three below: an emptyDir is gone at every restart by definition, a ConfigMap
-- is rendered from this model, and a HostPath states in `why` that losing it is
-- acceptable — which is emitted as the schema waiver on the rendered manifest,
-- so the reason lives where the finding is rather than in a comment beside it.
--
-- Exactly one source per volume, which the API cannot say and this does: the
-- API shape is four optional keys, and a record with two of them set is
-- writable there and rejected by the cluster.
let VolumeSource =
      < EmptyDir
      | ConfigMap : { name : Text }
      | HostPath : { path : Text, why : Text }
      >

let Volume = { name : Text, source : VolumeSource }

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
      , probeTiming : ProbeTiming
      , resources : Resources
      , volumes : List Volume
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
      , -- InnoDB's buffer pool, in GiB. `None` leaves the engine default, which
        -- is 128 MiB — fine for the five small databases and catastrophic for
        -- the one that is not.
        --
        -- ⚠ A FIELD RATHER THAN A FREE `args` LIST, because it is the one server
        -- flag the fleet sets and the one that must not drift from
        -- `resources.requests.memory`: the pool is resident, so a request that
        -- does not cover it is a pod the scheduler places on a node that cannot
        -- hold it. health-db is `Some 2` against a 2304Mi request — 2 GiB of
        -- pool plus mariadbd overhead.
        --
        -- It exists because `--check` caught its absence: rendering health-db
        -- without it silently cut a 4 GB database's pool by 16x, which is not a
        -- failure any manifest review would have seen.
        innodbBufferPoolGi : Optional Natural
      , resources : DbResources
      , keys : { user : Text, password : Text, rootPassword : Text }
      }

--| The WireGuard address of each cluster's node. An app reached over the tunnel
--  pins its hostPort to one of these, and DERIVES it from `cluster` rather than
--  repeating it: a hostPort with no `hostIP` DNATs on EVERY address the node has,
--  including the public one, and a k8s hostPort rule bypasses the NixOS firewall
--  entirely. Getting this wrong publishes the service.
let wgAddress
    : Cluster → Text
    = λ(c : Cluster) → merge { isis = "10.100.0.2", amun = "10.100.0.1" } c

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

--| How anything outside the pod gets to it. ONE field, replacing the pair
--  `host : Optional Text` + `exposure : Exposure`, because they were never
--  independent: a host with no exposure has no issuer, and an exposure with no
--  host describes nothing. Both inconsistent pairings were writable and are now
--  not.
--
-- The third arm is why this exists. `WireGuard` is not "an Ingress with a
-- private DNS name" — it is NO Ingress at all, a hostPort DNAT'd to the node's
-- tunnel address only, which is a network-layer gate rather than the obscurity
-- `Exposure.VpnOnly` provides. Three apps do it (scanner, recall, observe) and
-- each said so in a comment beginning "same as recall".
--
-- The port is NOT a field: it is the workload's own. A hostPort that disagrees
-- with the containerPort forwards to nothing, silently.
let Reach =
      < Ingress : { host : Text, exposure : Exposure }
      | WireGuard
      | --| Cluster-internal only: a Service and nothing else.
        Internal
      >

--| One thing an app is allowed to reach, and on which ports.
--
-- Addressed by NAMESPACE, not by pod labels: a chart's pod labels change across
-- versions where `kubernetes.io/metadata.name` is set by Kubernetes itself and
-- cannot drift.
let EgressTo = { namespace : Text, ports : List { port : Natural, protocol : Text } }

--| What NetworkPolicy an app declares, if any.
--
-- This replaces `netpol : Bool`, which could say one thing: render the
-- ingress-from-nginx policy, or nothing. That was never a switch on a single
-- policy — it named ONE policy, and three apps in the fleet carry a different
-- one entirely.
--
-- ⚠ The two arms differ in whether they are APPLIED, which is the part a Bool
-- hid. `IngressFromNginx` is rendered to its own `-held.yaml` and deliberately
-- kept out of the applied set: k3s enforces NetworkPolicy through kube-router,
-- which does not exempt node-sourced kubelet probe traffic, so applying it as
-- written drops the liveness probes and takes the app down. `Egress` IS applied
-- and has been running on scanner, recall and observe for months.
--
-- A union rather than a record of two optional policies, because no app in the
-- fleet has both and pretending otherwise would invent a state to test. When one
-- does, that is a change with a reason behind it.
let Netpol =
      < --| No policy of its own. `generate.sh` emits the `allow-no-netpol`
        --  waiver for these, which is the honest record of a namespace that has
        --  not been hardened yet.
        Unpoliced
      | --| Reachable only from the ingress controller. HELD — see above.
        IngressFromNginx
      | --| Default-deny egress, with named exceptions. An EMPTY list is the
        --  whole point rather than a degenerate case: it is deny-everything,
        --  which is what an app that talks to nothing outside its pod wants.
        Egress : List EgressTo
      >

--| Configuration the app's own container mounts as files.
--
-- The KEY is the filename inside the mount and the value is its whole contents,
-- which is what a k8s ConfigMap's `data` already means — so this is the upstream
-- shape rather than an invention.
--
-- Optional on `App` because most of the fleet has none: a service that reads its
-- configuration from the environment wants no ConfigMap, and one that has a
-- ConfigMap nobody mounts is a manifest that does nothing. The one app that
-- needs it (observe) IS its nginx vhost — there is no application backend at
-- all, so the configuration is the deployment.
--
-- ⚠ The name is stated, not derived, and the volume that mounts it names it
-- again. Bind it to a `let` in the app model so the two cannot drift: a
-- `VolumeSource.ConfigMap` pointing at a name nobody created is a pod stuck in
-- `ContainerCreating` with the reason several layers down in an event.
let ConfigMapDoc = { name : Text, files : List { mapKey : Text, mapValue : Text } }

let App =
      { name : Text
      , cluster : Cluster
      , db : Optional Database
      , storage : Optional Storage
      , configMap : Optional ConfigMapDoc
      , workload : Workload
      , reach : Reach
      , secrets : List SecretKey
      , netpol : Netpol
      }

in  { Cluster
    , Durability
    , Image
    , imageRef
    , pullPolicyFor
    , EnvValue
    , EnvVar
    , Probe
    , ProbeTiming
    , standardTiming
    , Quantity
    , Resources
    , DbResources
    , ConfigMapDoc
    , VolumeMount
    , VolumeSource
    , Volume
    , Writers
    , Storage
    , Workload
    , Database
    , SecretKey
    , Exposure
    , issuerFor
    , wgAddress
    , Reach
    , Netpol
    , EgressTo
    , App
    }
