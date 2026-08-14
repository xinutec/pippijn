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
--
-- `FromSecret` reads the app's OWN secret — the one `secrets` declares and
-- `secret.sh` writes, named `<app>-secret`. `FromUnmanagedSecret` names a
-- different one, and the distinction is the point rather than a convenience:
-- the app's secret is a thing this model knows the key list of, so a typo is
-- caught; a foreign secret is provisioned out-of-band and the model can only
-- state what it expects to find. health-sync's Google Health credentials live in
-- `health-google` for exactly that reason (long-lived OAuth refresh token,
-- managed by hand), so the arm exists to say so rather than to let any app quote
-- any secret.
let EnvValue =
      < Literal : Text
      | FromSecret : { key : Text, optional : Bool }
      | FromUnmanagedSecret : { secret : Text, key : Text, optional : Bool }
      >

let EnvVar = { name : Text, value : EnvValue }

--| How kubelet decides the container is alive. The timings are `ProbeTiming`
--  below; this is only the question being asked.
let Probe =
      < Http : { path : Text, port : Natural }
      | Exec : { command : List Text }
      | --| Just "is anything listening". For a server that has no health
        --  endpoint, which is honest about what is actually being checked.
        Tcp : { port : Natural }
      | --| NOTHING is probed, because there is nothing to probe.
        --
        -- signal's archiver is a websocket CLIENT: it dials signal-cli and
        -- writes rows, and listens on no port at all. A `Tcp` probe needs a
        -- port it does not have, and an `Exec` probe would be inventing a
        -- health command the image does not ship. It has carried
        -- `allow-no-probe` for months saying exactly this.
        --
        -- ⚠ `probeTiming` is then INERT — the pair is writable in a state where
        -- one half means nothing. `Reach` unified `host` + `exposure` for
        -- precisely that reason, and the same treatment (one `Probing` union
        -- carrying probe and timings together) is what this should become if a
        -- SECOND probeless workload appears. One case did not justify editing
        -- every model to move two fields into a constructor; two would.
        Unprobed
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

-- ⚠ A LIMIT IS NOT A REQUEST, and this is why `limits` is not a `Quantity`.
-- `memory` is required and `cpu` is not, which states the fleet's actual policy
-- rather than a symmetry:
--
--   * a memory limit is a KILL threshold. Exceeding it is an OOM-kill, which is
--     abrupt and legible. Omitting it is what `DL-K8S-NO-MEM-LIMIT` exists to
--     catch, so a `limits` block without one is a block that fails the check it
--     appears to satisfy — not a state worth being able to write.
--   * a CPU limit is a THROTTLE. Exceeding it does not kill anything; the CFS
--     quota simply stalls the container until the period rolls over, which shows
--     up as latency nobody can attribute. Whether that trade is worth making
--     depends on the workload, so it stays optional.
--
-- `messages` is the case that forced it: `limits: {memory: 256Mi}` with no cpu,
-- live and deliberate for months. Under `Quantity` the only way to model it was
-- to invent a CPU limit for a running pod — changing the cluster to satisfy a
-- type, which is backwards.
let Limits = { cpu : Optional Text, memory : Text }

--| `limits` is Optional, and WHICH containers may omit it is not a question
--  this type can answer.
--
-- It was required, on the argument that requests without limits is the state
-- `DL-K8S-NO-MEM-LIMIT` exists to catch. That does not survive contact with the
-- fleet: `signal-cli-rest-api` is an upstream image with requests only, and
-- `signal-archiver` is an image the fleet BUILDS with requests only. Both carry
-- `allow-no-mem-limit` and have for months. Requiring limits here would mean
-- inventing numbers for two live pods so that a type would accept them.
--
-- Whether a container ought to state limits depends on WHAT RUNS IN IT, and
-- dev-lint's `image_profile` already reasons about exactly that — it sets
-- `require_memory_limit = false` for every `is_db` container and demands limits
-- elsewhere unless waived. That is a decidable predicate over the rendered set
-- with a stated escape hatch: a linter's job, not a type's.
--
-- ⚠ This ABSORBS the former `DbResources`, which was this shape carved out for
-- databases alone. Two types saying one thing is how a rule stops being a rule —
-- and the second case (signal) proved the carve-out was never about databases.
-- health-db's argument still stands and is now stated at `innodbBufferPoolGi`:
-- ~4 GB with a 2 GB pool, where "a hard cap risks an OOM-kill mid-query".
let Resources = { requests : Quantity, limits : Optional Limits }

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

--| Whether the volume is re-chowned on every start.
--
-- Upstream's own taxonomy (`fsGroupChangePolicy`), not an invention. `Always`
-- is the Kubernetes default and renders as ABSENT, so saying it changes no
-- manifest; `OnRootMismatch` skips the recursive chown when the volume root
-- already carries the right group.
--
-- ⚠ On the CLAIM rather than the pod, though the API field is pod-level,
-- because the reason is the volume's SIZE: signal's attachments claim is 20 Gi
-- and re-chowning it at every start costs real time for nothing. A pod mounting
-- several claims takes `OnRootMismatch` if ANY of them asks — the cheap
-- direction, and the safe one.
let FsGroupChange = < Always | OnRootMismatch >

let Claim =
      { name : Text
      , storageGi : Natural
      , durability : Durability
      , writers : Writers
      , chown : FsGroupChange
      }

let Storage =
      { storageGi : Natural
      , mountPath : Text
      , -- Optional for the reason `VolumeMount.subPath` is — adding one to a
        -- live mount hides the data that was there.
        subPath : Optional Text
      , durability : Durability
      , writers : Writers
      , chown : FsGroupChange
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
      | Claim : Claim
      >

let Volume = { name : Text, source : VolumeSource }

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
      | Internal
      | NoService
      >

--| Work that runs on a schedule and exits, as against a `Workload`, which runs
--  until something stops it.
--
-- ⚠ `deadlineSeconds` is REQUIRED, and it is the field this type exists for. A
-- batch workload has no Service, no probe and no readiness — nothing watches it,
-- so the ONLY thing standing between a wedged run and a job that never ends is
-- this number. Kubernetes defaults it to unset, i.e. forever. Every one of
-- health's crons sets it and each has a different value, so it is neither
-- derivable nor safely defaulted.
let ScheduledTask =
      { name : Text
      , -- `*/15 * * * *`. In the cluster's timezone, which is UTC.
        schedule : Text
      , command : List Text
      , deadlineSeconds : Natural
      , -- Defined but not running. Kubernetes keeps this in `spec.suspend`, and
        -- it is the field most likely to exist ONLY in the cluster: suspending
        -- is what you do from a terminal at the moment something misbehaves, and
        -- `kubectl patch` leaves no trace in any repo.
        --
        -- ⚠ health-bus-refresh was found exactly that way on 2026-08-13 —
        -- suspended in the cluster, no `suspend:` in its manifest, and never run
        -- in the 62 days since it was created. A model that omitted the field
        -- would have declared a daily job that does not run, which is worse than
        -- the drift it replaced: it would read as reviewed.
        suspended : Bool
      , env : List EnvVar
      , resources : Resources
      }

--| Whether this pod can be run as a non-root user.
--
-- `NonRoot` is the fleet default and what every workload but one uses. The
-- exception is not laziness: `signal-cli-rest-api`'s entrypoint runs
-- `usermod`/`groupmod` as root before dropping to uid 1000, and forcing
-- `runAsNonRoot` makes those calls fail with "cannot lock /etc/group" and
-- crash-loops the container. Somebody already paid to learn that; the manifest
-- carried it as an `allow-unhardened` comment, and this makes it structural.
--
-- `why` is required for the same reason `Durability.LossAccepted` and
-- `HostPath` require one: the permissive arm has to be argued, and the argument
-- belongs where the decision is, not in a waiver a linter reads.
--
-- ⚠ `uid` stays meaningful under `Unhardened` — it is the `fsGroup` that keeps
-- the volume writable by whatever user the entrypoint drops to. What is dropped
-- is `runAsNonRoot`/`runAsUser`/`runAsGroup`, not the pod's relationship to its
-- storage.
let Hardening = < NonRoot | Unhardened : { why : Text } >

--| A long-running container plus the Service in front of it.
let Workload =
      { name : Text
      , -- How anything outside this pod gets to it. ON THE WORKLOAD, not the
        -- namespace: signal runs a REST bridge (Internal), an archiver
        -- (NoService) and, in another repo tree entirely, a viewer (Ingress).
        reach : Reach
      , image : Image
      , command : Optional (List Text)
      , port : Natural
      , uid : Natural
      , hardening : Hardening
      , readOnlyRootFs : Bool
      , env : List EnvVar
      , probe : Probe
      , probeTiming : ProbeTiming
      , resources : Resources
      , volumes : List Volume
      , mounts : List VolumeMount
      , -- Batch work sharing THIS workload's image, uid and root-filesystem
        -- posture. On the workload rather than the namespace because that is
        -- where the sharing is: a scheduled task is the same program with a
        -- different entrypoint. A namespace-level list could not say WHICH
        -- image a task runs once a namespace holds more than one workload, and
        -- picking the first would be a silent answer to a real question.
        tasks : List ScheduledTask
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
      , resources : Resources
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

--| A declared secret key. `apps/*.dhall` builds a record of these and refers to
--  its fields, which is how a mistyped key becomes a compile error.
let SecretKey = { mapKey : Text, mapValue : Text }


--| One thing an app is allowed to reach, and on which ports.
--
-- Addressed by NAMESPACE, not by pod labels: a chart's pod labels change across
-- versions where `kubernetes.io/metadata.name` is set by Kubernetes itself and
-- cannot drift.
let EgressTo =
      { namespace : Text, ports : List { port : Natural, protocol : Text } }


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
--| One thing a rule may allow traffic TO.
--
-- Four arms because signal needs four shapes and no fewer. Each names WHAT it
-- selects rather than how, so a rule reads as a sentence:
--
--   * `Namespace` — every pod in another namespace, by the automatic
--     `kubernetes.io/metadata.name` label. Chart pod labels change across
--     versions; that one is set by Kubernetes and cannot drift.
--   * `Workload` — one workload in THIS namespace, by its `app` label.
--   * `NamespacedWorkload` — pods in another namespace matching labels. Needed
--     because `namespaceSelector` and `podSelector` in the SAME peer mean "both
--     must hold", where two separate peers would mean "either" — a distinction
--     that silently widens a policy if you get it wrong.
--   * `Internet` — an ipBlock of everything except the ranges listed.
--
-- ⚠ `Internet` is how you say "the public internet" and there is no shorter
-- way. `ipBlock` cannot name the node's own address either: see #781, where a
-- rule naming isis's public IP matched nothing because CNI-HOSTPORT-DNAT
-- rewrites the destination before kube-router's filter rules see it.
let NetpolPeer =
      < Namespace : Text
      | Workload : Text
      | --| Any pod in THIS namespace — `podSelector: {}`, a selector with no
        --  terms. signal's default-deny uses it to let everything reach the
        --  database and the REST bridge without naming them one by one, which
        --  also means a workload added later is covered rather than silently
        --  cut off.
        SameNamespace
      | NamespacedWorkload :
          { namespace : Text, labels : List { mapKey : Text, mapValue : Text } }
      | Internet : { except : List Text }
      >

let NetpolRule =
      { to : List NetpolPeer
      , ports : List { port : Natural, protocol : Text }
      }

--| Which pods a policy governs. `WholeNamespace` renders `podSelector: {}` — a
--  selector with no terms, which matches EVERY pod in the namespace.
let NetpolTarget = < WholeNamespace | OneWorkload : Text >

--| A named egress policy. Egress-only by construction, which is not a
--  simplification: k3s enforces through kube-router, which does not exempt
--  node-sourced kubelet probe traffic, so a default-deny INGRESS drops the
--  probes and takes the pod NotReady. Every applied policy in this fleet is
--  egress, and this type cannot express otherwise.
let NetpolPolicy =
      { name : Text, target : NetpolTarget, egress : List NetpolRule }

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
        --
        -- SUGAR for `Policies [ one WholeNamespace policy ]`, the way `App` is
        -- sugar for `Namespace` — three apps say exactly this and there is no
        -- reason to make them spell it out.
        Egress : List EgressTo
      | --| Policies as they actually are: several, each targeting the namespace
        --  or one workload, with peers of any shape.
        --
        -- signal needs three — a namespace-wide default-deny, one workload
        -- allowed to the internet on 443, and another allowed to the ingress
        -- controller for SSO — and `Egress` can express none of them.
        Policies : List NetpolPolicy
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

--| A namespace and everything in it.
--
-- `App` below is the ONE-WORKLOAD CASE of this, and `namespaceOf` is the
-- embedding. The fleet has three namespaces that are not one workload — signal
-- runs a database, a REST bridge and an archiver, and `messages` is a fourth
-- pod in that same namespace because a `secretKeyRef` cannot cross namespaces —
-- and `App` cannot describe any of them.
--
-- ⚠ WHAT THE OLD CARDINALITY WAS SILENTLY PROVING. With exactly one workload,
-- four properties held by construction; at `List Workload` they become
-- representable and NOTHING here forbids them:
--
--   1. workload names are unique — names derive labels, labels drive Service
--      selectors, so two workloads sharing a name gives one Service selecting
--      two different pods, and it fails as intermittent wrong answers;
--   2. a NetworkPolicy peer names a workload that exists — one that does not
--      matches nothing, silently, which is #781's failure wearing a new hat;
--   3. hostPorts do not collide — the second workload to bind 8000 never
--      schedules;
--   4. one writer per PVC — `Writers.Exclusive` currently constrains THE
--      workload, not a set of them.
--
-- None of the four is statable in Dhall: they are uniqueness and cardinality
-- claims over a list, and this language has no dependent types or refinements to
-- say them with. Each is a decidable predicate over the RENDERED manifest set,
-- which is dev-lint's job — so generalising this type without those rules
-- landing alongside it is strictly worse than the conflation it replaces, since
-- the conflation at least made them impossible.
--
-- `reach` moved onto `Workload` (a namespace with three pods has three answers
-- to "how is this reached"), and `storage` became `claims` plus an ordinary
-- volume/mount pair — `namespaceOf` performs that translation, so `App` keeps
-- its single-`Storage` sugar and no model file changed for it.
--| Who creates the namespace this tree deploys into.
--
-- `Own` is every tree but one. `Elsewhere` exists because `messages` is a pod in
-- the `signal` namespace — a `secretKeyRef` cannot cross namespaces and it reads
-- `signal-secret` — so `kubes/signal/k8s` creates the namespace and
-- `kubes/messages/k8s` deploys into it.
--
-- ⚠ ONE STATEMENT, FOUR CONSEQUENCES, which is why this is a field rather than
-- four. Saying "the namespace is someone else's" settles all of them at once:
--
--   1. no Namespace object is rendered — a second copy of a shared object is how
--      two trees start fighting over it (`site.dhall` says the same for `web`);
--   2. no `allow-no-netpol` waiver — the namespace IS policed, by the owner's
--      tree, and dev-lint fails a waiver that waives nothing;
--   3. nothing may be named after `name`, because `name` is someone else's;
--   4. so the names that would have been derived are carried HERE instead.
--
-- The payload is not a bundle of unrelated fields: it is exactly what losing
-- ownership of the name takes away.
let Owner =
      < --| This tree creates the namespace, and every object named after it.
        Own
      | Elsewhere :
          { --| The tree that does create it, relative to `kubes/`. Documentation
            --  — nothing resolves it — but a reviewer reading a manifest with no
            --  Namespace in it needs to know where the Namespace went.
            tree : Text
          , --| This app's own identity, which for an owned namespace IS the
            --  namespace name. Names the Secret and the TLS secret: `messages`
            --  reads `messages-secret` while living in `signal`.
            slug : Text
          , --| The Ingress object's name, stated because it cannot be derived:
            --  the live object is `messages`, with no `-ingress` suffix, and
            --  every other tree's is `${name}-ingress`.
            --
            -- ⚠ Renaming a live Ingress is delete-then-create rather than
            -- apply — the nginx admission webhook refuses the overlap — so this
            -- name predates the model and outlives it. Same reason
            -- `signal-cli-egress-internet` and `site.dhall`'s `Overlay.name` are
            -- stated: an object that exists has a name already.
            ingressName : Text
          }
      >

--| A file in the live tree this model does NOT produce, with the reason.
--
-- Stating them is what keeps `--check` honest: a manifest the model has never
-- heard of is a failure, and the only way to make one not a failure is to say so
-- here, where a reviewer sees it. Same escape hatch as `Durability.LossAccepted`
-- and it costs the same sentence. Lifted from `site.dhall`, which needed it
-- first and for the same reason.
let Unowned = { file : Text, why : Text }

let Namespace =
      { name : Text
      , owner : Owner
      , cluster : Cluster
      , db : Optional Database
      , configMap : Optional ConfigMapDoc
      , claims : List Claim
      , workloads : List Workload
      , secrets : List SecretKey
      , netpol : Netpol
      , unowned : List Unowned
      }

let App =
      { name : Text
      , cluster : Cluster
      , db : Optional Database
      , storage : Optional Storage
      , configMap : Optional ConfigMapDoc
      , workload : Workload
      , secrets : List SecretKey
      , netpol : Netpol
      }

--| The embedding ι : App → Namespace. An app IS a namespace holding one
--  workload, and this is the only expression that says so.
--
-- Every renderer that had to generalise takes a `Namespace`; the `App`-shaped
-- entry points the generator calls are one-line wrappers around this. So the 14
-- app models are unchanged and unchangeable by the refactor, and
-- `generate.sh --check` decides exactly the obligation that matters:
--
--     ∀ a ∈ the 14 models . render_new(namespaceOf a) ≡ render_old(a)
--
-- ⚠ 14 points is not ∀. Dhall's normalisation is decidable but function
-- extensionality is not available, and `App` has infinitely many inhabitants
-- (Text, Natural, List), so this is the theorem checked at every point that
-- exists rather than proved for all of them. That is the ceiling here, and it is
-- worth stating rather than implying more.
let namespaceOf
    : App → Namespace
    = λ(a : App) →
        let dataVolumeName = "app-data"

        let claimName = "${a.name}-data-pvc"

        let claimOf =
              λ(s : Storage) →
                { name = claimName
                , storageGi = s.storageGi
                , durability = s.durability
                , writers = s.writers
                , chown = s.chown
                }

        let claims =
              merge
                { None = [] : List Claim
                , Some = λ(s : Storage) → [ claimOf s ]
                }
                a.storage

        let extraVolumes =
              merge
                { None = [] : List Volume
                , Some =
                    λ(s : Storage) →
                      [ { name = dataVolumeName
                        , source = VolumeSource.Claim (claimOf s)
                        }
                      ]
                }
                a.storage

        let extraMounts =
              merge
                { None = [] : List VolumeMount
                , Some =
                    λ(s : Storage) →
                      [ { name = dataVolumeName
                        , mountPath = s.mountPath
                        , subPath = s.subPath
                        , readOnly = False
                        }
                      ]
                }
                a.storage

        in    a.{ name, cluster, db, configMap, secrets, netpol }
            ⫽ { -- An app IS its namespace: it creates the object and every name
                -- derives from it. So the embedding fills both new fields and no
                -- model file changes, which is what keeps `--check` a proof
                -- about ι rather than a regression test.
                owner = Owner.Own
              , unowned = [] : List Unowned
              , claims
              , workloads =
                [   a.workload
                  ⫽ { volumes = a.workload.volumes # extraVolumes
                    , mounts = a.workload.mounts # extraMounts
                    }
                ]
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
    , Limits
    , Resources
    , ConfigMapDoc
    , VolumeMount
    , VolumeSource
    , Volume
    , FsGroupChange
    , Claim
    , Writers
    , Storage
    , Hardening
    , Workload
    , ScheduledTask
    , Owner
    , Unowned
    , Namespace
    , namespaceOf
    , Database
    , SecretKey
    , Exposure
    , issuerFor
    , wgAddress
    , Reach
    , NetpolPeer
    , NetpolRule
    , NetpolTarget
    , NetpolPolicy
    , Netpol
    , EgressTo
    , App
    }
