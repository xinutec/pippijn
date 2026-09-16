{-
WHERE A COMMENT MAY SIT, and why every doc block here is BELOW its `let`'s `=`.

`dhall format` deletes most comments. It keeps only those following a token that
opens an expression, measured across thirteen positions:

  KEPT     top of the file
           after a `let`'s `=`            <- where every block in this file now is
           after `{` or `,`, before a field name (record literals AND types,
           nested included)

  DELETED  above a `let`  (where these all used to be)
           trailing a value, `x = 1 -- why`
           on its own line BEFORE a `,` — one line up from a position that keeps
           anywhere inside a union: `< A | -- why` is gone, and so is the layout

Before this file was rearranged, formatting it took 750 comment lines to 96.
After, it loses 68 — every one of them a union arm, which nothing can fix: the
formatter collapses `< A | B | C >` onto one line and no position inside it
survives. `Probe` and `PvcRetention` below are where that bites.

⚠ So the tree is NOT safe to format, and `code/kubes/scripts/dhall-comments.sh`
is still the net. What changed is the size of the hole: 46% of the tree's
comments to 4%. If you add a doc block, put it after the `=`, not above the
`let`, or the next person to run the formatter deletes it and no test will fail.
-}
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

let Cluster =
      --| Which k3s cluster an app is scheduled on.
      < isis | amun >

let Image =
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

let pullPolicyFor
    : Image → Optional Text
    =
      --| Never, for a `Local` image; the cluster's own default for anything else.
      --
      -- Derived rather than declared, so "hand-imported" and "do not pull" cannot come
      -- apart. A `Local` image whose policy was left at the default pulls on the first
      -- restart after the node reboots, fails, and takes the app down at the moment
      -- nobody is watching.
      λ(i : Image) →
        merge
          { Fleet = λ(_ : Text) → None Text
          , Upstream = λ(_ : { repo : Text, tag : Text }) → None Text
          , Local = λ(_ : Text) → Some "Never"
          }
          i

let EnvValue =
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
      < Literal : Text
      | FromSecret : { key : Text, optional : Bool }
      | FromUnmanagedSecret : { secret : Text, key : Text, optional : Bool }
      >

let EnvVar = { name : Text, value : EnvValue }

let Probe =
      --| How kubelet decides the container is alive. The timings are `ProbeTiming`
      --  below; this is only the question being asked.
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

let ProbeTiming =
      --| How often kubelet asks, and how long it waits first.
      --
      -- NOT literals in the renderer. "The timings are a property of the workload
      -- kind" holds only while every modelled app is a web service behind an
      -- Ingress; it breaks on the tunnel-only apps, which start in two to three
      -- seconds and want to be marked ready in that time rather than in five — and,
      -- being reached by a hostPort that cannot roll, spend the difference as
      -- downtime on every deploy.
      --
      -- Required rather than optional, and `standardTiming` is one definition: an app
      -- says which set it uses and a reader can see it, but there is still exactly one
      -- place the fleet default is written down.
      { readiness : { initialDelaySeconds : Natural, periodSeconds : Natural }
      , liveness :
          --| ⚠ OPTIONAL, because "no liveness probe" is a real and often correct
          --  state and the model must be able to SAY it rather than impose one.
          --
          -- `ircd` is the case that forced it: the live Deployment has readiness
          -- and no liveness, and requiring one would have added a probe to a
          -- running IRC server — a cluster change to satisfy a type, which is
          -- backwards, and a risky one. A liveness probe that kills a container
          -- merely slow to start turns a slow boot into a crash loop, which is
          -- strictly worse than having none; `vps-pippijn` measured that at 16s
          -- then 31s to Ready against a kubelet that kills at ~25s.
          --
          -- ⚠ Absent is NOT the same as `standardTiming`'s. This says the
          -- container has no liveness probe at all; that says it has the fleet's.
          Optional { initialDelaySeconds : Natural, periodSeconds : Natural }
      }

let standardTiming
    : ProbeTiming
    =
      --| The reviewed set: the fleet default, written down once.
      { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
      , liveness = Some { initialDelaySeconds = 15, periodSeconds = 20 }
      }

let Readiness =
      --| A readiness probe that asks a DIFFERENT question from liveness, with the two
      --  timings a deep probe cannot leave at kubelet's defaults.
      --
      -- ⚠ `timeoutSeconds` defaults to 1: a handler that reaches a database is cut
      -- off as a probe TIMEOUT — NotReady with no status code, no log line, no cause
      -- named. Set it above the handler's own budget and the failure arrives as a
      -- 503 the app wrote down. `failureThreshold` decides how much slowness is a
      -- fault; on a single-replica app, one slow answer withdraws the only pod.
      --
      -- Both required rather than optional: a workload writing this field has already
      -- decided the fleet defaults do not fit.
      { probe : Probe, timeoutSeconds : Natural, failureThreshold : Natural }

let Quantity = { cpu : Text, memory : Text }

let Limits =
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
      { cpu : Optional Text, memory : Text }

let Resources =
      --| `limits` is Optional: which containers may omit it depends on WHAT RUNS in
      --  them, which dev-lint's `image_profile` decides over the rendered set.
      --  Requiring it here would mean inventing numbers for pods that run without.
      { requests : Quantity, limits : Optional Limits }

let VolumeMount =
      --| `readOnly` is stated, not defaulted: a read-only mirror and a scratch
      --  directory are otherwise the same three fields.
      --
      -- `subPath` is Optional and that is a DATA-SAFETY property, not tidiness: a
      -- mount that gains one stops seeing the volume's root and starts seeing an
      -- empty child. To the app that is indistinguishable from its data having been
      -- lost. So a mount that has none must be able to say so rather than being given
      -- one to satisfy the type.
      { name : Text
      , mountPath : Text
      , subPath : Optional Text
      , readOnly : Bool
      }

let Durability =
      --| A persistent volume the app's *own* container writes to.
      --
      -- Distinct from a `Database`'s storage, which the engine owns and the app never
      -- touches. Optional because most apps keep their state in a database.
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
      < --| A backup-prepare.sh block copies it. dev-lint's PVC ⊗ backup join
        --  checks that claim across the whole fleet, so stating it here without
        --  writing the block is caught rather than believed.
        BackedUp
      | --| Losing it is acceptable, and `why` says why. Emitted as the waiver on
        --  the rendered claim, where the finding is.
        LossAccepted : { why : Text }
      >

let Writers =
      --| May two pods hold this volume at once?
      --
      -- A fact about how the app WRITES, not derivable from the manifest.
      -- `Exclusive` renders `strategy: Recreate`, so a rolling update never overlaps
      -- two instances.
      --
      -- ⚠ Atomic writes do not answer this. Write-then-rename stops a reader seeing
      -- a half-written file and does nothing about two pods each holding a whole
      -- document, where the one that renames last erases the other's update (#744).
      --
      -- `Concurrent` carries `why` and `Exclusive` does not, deliberately: the safe
      -- answer is free and the permissive one has to be argued. Only the apps that
      -- declare their OWN storage answer this — five of the seven modelled apps keep
      -- their state in a database and never reach it.
      < --| One pod at a time. The volume holds a document the pod rewrites
        --  whole, so a second instance's stale copy would overwrite the first's
        --  work rather than merge with it.
        Exclusive
      | --| Two at once is safe, and `why` says why it is safe HERE.
        Concurrent : { why : Text }
      >

let FsGroupChange =
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
      < Always | OnRootMismatch >

let ClaimType =
      { name : Text
      , storageGi : Natural
      , durability : Durability
      , writers : Writers
      , chown : FsGroupChange
      , -- ⚠ **`None` OMITS IT, and that is right for every generated tree** —
        -- k3s's default StorageClass IS `local-path`, so naming it adds a line
        -- that says what the cluster already does.
        --
        -- ⚠ **But it is IMMUTABLE on a live PVC and recorded in
        -- last-applied-configuration.** The four hand-written trees that declare
        -- it (ircd, vaultwarden, mailu, irssi) therefore cannot stop: a
        -- generated manifest omitting it is REJECTED on apply, not silently
        -- ignored. Modelling what IS beats modelling what would be tidy.
        storageClass : Optional Text
      }

let Claim =
      --| `Claim` as a SCHEMA. Second use of `{ Type, default }` in this model, after
      -- `Workload` — see there for when a field earns a default.
      { Type = ClaimType, default.storageClass = None Text }

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

let VolumeSource =
      --| A volume that is NOT the app's own persistent claim.
      --
      -- `Storage` stays separate because `Durability` — what happens to this on a
      -- restore — is real for a PVC and vacuous for these. A `HostPath`'s `why` is
      -- emitted as the schema waiver on the rendered manifest.
      --
      -- Exactly ONE source per volume, which the API cannot say: its shape is four
      -- optional keys, and a record with two set is writable and then rejected.
      --
      -- `Secret` mounts material a program insists on reading from a path with a mode
      -- it approves of — ssh refuses a key any other user can read, and the API
      -- defaults to 0644.
      --
      -- ⚠ `mode` is the API's DECIMAL. Use [`fileMode`](#fileMode) rather than 384.
      < EmptyDir
      | ConfigMap : { name : Text }
      | HostPath : { path : Text, why : Text }
      | Claim : Claim.Type
      | Secret : { name : Text, mode : Optional Natural }
      >

let Volume = { name : Text, source : VolumeSource }

let fileMode =
      --| The file modes worth mounting a secret with, named because the API wants
      --  them in decimal and nobody reads 384 as `rw-------`.
      --
      -- ⚠ `ownerRead` (0400) is a trap on a secret volume unless the pod also sets
      -- `fsGroup`: those files are owned by **root**, not by `runAsUser`, so 0400
      -- means the process cannot read its own secret. It surfaces as the file being
      -- silently empty — an unreadable `known_hosts` reads to ssh as "no host key
      -- known", not as a permissions error.
      --
      -- `anyoneRead` (0444) is the honest mode for a secret a non-root process must
      -- read, and it is not the exposure it looks like: the volume exists only inside
      -- that pod. Anything needing tighter (ssh refuses a private key with ANY group
      -- or other bit set) should copy the file and chmod it, which is what
      -- `signal-irclog-import` does.
      { ownerRead = 256, ownerReadWrite = 384, anyoneRead = 292 }

let Exposure =
      --| Which socket serves an app's hostname. `Public` is served on the node's public
      -- address and on the tunnel; `VpnOnly` on the WireGuard address and NOWHERE ELSE.
      --
      -- ⚠ A REAL boundary (#1294), not obscurity at the DNS layer: one shared ingress
      -- answering every name on every address would be the latter.
      -- Host nginx emits a `server` block per name whose `listen` addresses come
      -- from this field, so a VpnOnly name has no public listener at all — and
      -- `plan-run frontdoor-check --vpn-addr` reads the generated nginx.conf and fails
      -- if one appears in a block listening on anything else. Checked, not trusted.
      --
      -- Certificates no longer follow from this field: every name is issued by DNS-01
      -- from `security.acme` on the host.
      < Public | VpnOnly >

let Published =
      --| How anything outside the pod gets to it. ONE field, replacing a `host` +
      -- `exposure` pair that were never independent — a host with no exposure has no
      -- issuer, an exposure with no host describes nothing, and both inconsistent
      -- pairings were writable.
      --
      -- ⚠ The third arm is why this exists: `WireGuard` is NOT an Ingress with a
      -- private name. It is no Ingress at all — a hostPort DNAT'd to the node's tunnel
      -- address only, a network-layer gate rather than obscurity.
      --
      --| A container port and the node port it is published at.
      -- ⚠ The two are FREE TO DIFFER: the CNI portmap plugin DNATs the host dport to
      -- the container's port. `WireGuard` still names one number for both, but
      -- that is a POLICY it chooses, not a rule the cluster enforces.
      { containerPort : Natural, hostPort : Natural }

let Reach =
      < Ingress : { host : Text, exposure : Exposure }
      | -- ⚠ `alsoPublish` names the EXTRA ports, not all of them: `Workload.port`
        -- is always published, so "probing a port you do not publish" is
        -- unrepresentable here. Each is bound at the same number on the tunnel
        -- address.
        WireGuard : { alsoPublish : List Natural }
      | -- Published straight onto every node interface, with NO Service.
        --
        -- ⚠ **NOT Kubernetes' `type: NodePort`** — deliberately not named that.
        -- There is no Service at all here; a Service is the thing being avoided.
        --
        -- ⚠ `hostIP` is UNSET — the difference from `WireGuard`, which pins to the
        -- tunnel address. These bind every interface because the clients are people
        -- on the internet.
        --
        -- A LIST because one container may publish several ports.
        -- ⚠ `Workload.port` stays the port the probes ask about, and must be among
        -- these.
        --
        -- `why` becomes the `DL-K8S-HOST-PORT` waiver.
        HostPorts : { published : List Published, why : Text }
      | Internal
      | NoService
      >

let RootFs =
      --| Whether the container's root filesystem is read-only.
      --
      -- `Writable`'s `why` becomes the `allow-rootfs-rw` waiver. A reason written in
      -- a Dhall comment instead cannot reach the renderer, so dev-lint reports a
      -- decision nobody disagreed with.
      < ReadOnly | Writable : { why : Text } >

let ScheduledTask =
      --| Work that runs on a schedule and exits, as against a `Workload`, which runs
      --  until something stops it.
      --
      -- ⚠ `deadlineSeconds` is REQUIRED, and it is the field this type exists for. A
      -- batch workload has no Service, no probe and no readiness — nothing watches it,
      -- so the ONLY thing standing between a wedged run and a job that never ends is
      -- this number. Kubernetes defaults it to unset, i.e. forever. Every one of
      -- health's crons sets it and each has a different value, so it is neither
      -- derivable nor safely defaulted.
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
        -- ⚠ A model that omitted the field would declare a daily job that does
        -- not run, which is worse than the drift it replaces: it reads as
        -- reviewed.
        suspended : Bool
      , -- ⚠ ITS OWN, not the workload's, and one live case is why. A task shares
        -- its workload's image and uid, and it shared the root-filesystem
        -- posture too — including the REASON, once `RootFs` started carrying
        -- one. `signal-irclog-import` runs under the ingester and inherited
        -- "writes downloaded blobs under /attachments", which is not what it
        -- does: it does `install -m 400 …/id_ed25519 /tmp/key`, and its writable
        -- filesystem is the same ssh-key story as irc-tail's. A waiver stating
        -- the wrong reason is worse than a missing one — it reads as reviewed.
        --
        -- The posture may now differ from the workload's as well, which is
        -- strictly more precise: a batch container that needs nothing writable
        -- can say so even where the long-running one does.
        rootFs : RootFs
      , env : List EnvVar
      , resources : Resources
      , -- A task's OWN storage, not the workload's.
        --
        -- ⚠ These are separate from the workload's `volumes`/`mounts` on
        -- purpose. Inheriting the workload's would give a batch job write access
        -- to the
        -- long-running pod's data — the ingester's attachment store, say — to
        -- get at a scratch directory it wanted for something else entirely. A
        -- job that needs storage should have to say which.
        volumes : List Volume
      , mounts : List VolumeMount
      }

let Hardening =
      --| Whether this pod can be run as a non-root user.
      --
      -- `NonRoot` is the default. The one exception is an image whose entrypoint
      -- runs `usermod`/`groupmod` as root before dropping privileges: forcing
      -- `runAsNonRoot` fails it with "cannot lock /etc/group" and crash-loops.
      --
      -- `why` becomes the `allow-unhardened` waiver.
      --
      -- ⚠ `uid` stays meaningful under `Unhardened` — it is the `fsGroup` that keeps
      -- the volume writable. Only `runAsNonRoot`/`runAsUser`/`runAsGroup` are
      -- dropped.
      < NonRoot | Unhardened : { why : Text } >

let Selector =
      --| Which label key a Deployment selects its pods on.
      --
      -- ⚠ `spec.selector` is IMMUTABLE: getting it wrong is delete-and-recreate,
      -- which here means dropping a live IRC session or an ssh terminal server.
      -- Hence a union rather than free Text, spelled at every workload.
      --
      -- Two conventions, neither going away: app trees derive `app: <name>`, while
      -- `ircd`, `vps-pippijn` and `vps-simon` predate them and select `run: <name>`.
      --
      -- ⚠ Only the workload's own selector — a database Deployment always derives
      -- `app:`, being generated.
      < App | Run >

let VolumeOwnership =
      --| Who makes a mounted claim writable by the process that uses it.
      --
      -- ⚠ NOT DERIVABLE from posture or from "has a claim". It is a fact about the
      -- IMAGE: an entrypoint that chowns its own mounts before dropping privileges
      -- needs no `fsGroup`, and one that does not, does.
      --
      -- ⚠ `RunsAsRoot` is a third cause, not a spelling of the second. A container
      -- that merely runs as root does not chown anything, and claiming it does puts
      -- a false statement in the model. An `fsGroup` there would add a field the
      -- live pod lacks and trigger a recursive chown of its data.
      --
      -- Each exception carries `why` because the renderer emits it as the waiver;
      -- a reason in a Dhall comment cannot reach one.
      < FsGroup
      | EntrypointChowns : { why : Text }
      | RunsAsRoot : { why : Text }
      >

let SidecarType =
      --| A SECOND long-running container in a workload's pod, from the SAME image.
      --
      -- One image, two commands. A sidecar CANNOT name its own image, and inherits
      -- the workload's uid, hardening, rootFs and pull policy: one pod, one posture.
      { name : Text
      , command : List Text
      , -- The port this container serves, rendered under the WORKLOAD's reach:
        -- on a WireGuard workload it gets its own wg-pinned hostPort beside the
        -- main container's. `None` = serves nothing (a pure worker).
        port : Optional Natural
      , env : List EnvVar
      , -- What kubelet asks this container — both probes, kubelet's default
        -- timings. The main container's `probeTiming` is not borrowed: those
        -- numbers were measured for THAT process.
        probe : Probe
      , -- Mount everything the main container mounts, at the same paths. The
        -- honest grain for a sidecar that exists to share the workload's data
        -- (recalld shares recall's /data); a sidecar needing its OWN mounts is
        -- a future field, not a reinterpretation of this one.
        shareMounts : Bool
      }

let Sidecar =
      { Type = SidecarType
      , default =
        { port = None Natural
        , env = [] : List EnvVar
        , probe = Probe.Unprobed
        , shareMounts = False
        }
      }

let WorkloadType =
      --| A long-running container plus the Service in front of it.
      { name : Text
      , containerName :
          --| The container's own name, when it is not the workload's.
          --
          -- `None` means "the same as `name`", which is every tree but one and is
          -- why this is Optional rather than required — seventeen models would
          -- otherwise restate a name the Deployment already carries.
          --
          -- ⚠ `ircd` is the exception and it is not tidiness: the Deployment is
          -- `inspircd` and the container inside it is `ircd`. Renaming the
          -- container to match would change the pod template and RESTART a live
          -- IRC server — the rule `vps-pippijn` set, that the model does not get
          -- to charge a rollout for a name.
          Optional Text
      , -- How anything outside this pod gets to it. ON THE WORKLOAD, not the
        -- namespace: signal runs a REST bridge (Internal), an archiver
        -- (NoService) and, in another repo tree entirely, a viewer (Ingress).
        reach : Reach
      , image : Image
      , command : Optional (List Text)
      , port : Natural
      , uid : Natural
      , hardening : Hardening
      , rootFs : RootFs
      , selector : Selector
      , volumeOwnership : VolumeOwnership
      , {-| `nginx.ingress.kubernetes.io/proxy-body-size`, when the default 1m is
            too small. `None` omits the annotation entirely.

            ⚠ On the WORKLOAD rather than inside `Reach.Ingress`, for the reason
            `volumeOwnership` is: a defaulted field costs the other workloads
            nothing, where widening the union arm's record would make all ten
            existing `Reach.Ingress` constructors name a value they do not care
            about.

            vaultwarden is the user: Bitwarden clients' sync payloads exceed
            nginx's default, so its Ingress carries `128m`.
        -}
        maxBodySize : Optional Text
      , {-  The path the FRONT DOOR should ask for to decide this name is
            working — not the path kubelet probes.

            ⚠ **THEY ARE DIFFERENT QUESTIONS AND MUST NOT BE THE SAME PATH.**
            `probe` is kubelet's LIVENESS target, and a liveness probe that
            checks a dependency turns a database blip into a crashloop: the pod
            is killed for something a restart cannot fix, and the restarts add
            load to whatever was already struggling. So a liveness path stays
            dumb, and this one is allowed to be expensive and honest.

            `None` means the front door asks for `/`, which is right for a
            redirect, a static site, or anything whose root already exercises
            what matters. It is WRONG for a single-page app: `/` is the bundle,
            served by the same process, and it answers 200 while the app's
            database is unreachable — a name can serve 502 for a day with every
            front-door goal green, and a root-only probe still would not see an
            app that is up but blind.
        -}
        serviceCheck : Optional Text
      , -- Overrides what the image kind implies. `None` means "ask
        -- `pullPolicyFor`", which is right for every generated tree: a Fleet
        -- image names no policy and Kubernetes defaults `:latest` to `Always`.
        --
        -- ⚠ Exists so a HAND-WRITTEN tree that spells the default out can be
        -- modelled WITHOUT a rollout. irssi's live container says
        -- `imagePullPolicy: Always` — redundant, but removing it would change
        -- the pod template and restart a bouncer holding live IRC sessions. The
        -- model describes what is; it does not get to charge a restart for
        -- tidiness.
        pullPolicy : Optional Text
      , env : List EnvVar
      , -- The question kubelet asks. Asked for BOTH probes unless `readiness`
        -- below names a different one.
        --
        -- ⚠ ONE probe answering both is right for most of these — a static site,
        -- a UI with no backing store — and wrong the moment the two questions
        -- have different answers. It fails in the direction that hurts:
        -- fleetwatch pointed both at `/healthz`, which returned the constant
        -- `"ok"`, so readiness asserted "this pod can serve" while every read
        -- 500'd on an exhausted pool. A probe that cannot fail does not merely
        -- miss the fault, it asserts the opposite of it.
        probe : Probe
      , -- A different question for readiness, when "is the process up" and "can
        -- it serve" are not the same question.
        --
        -- `None` means ask `probe` twice, which is what every workload here did
        -- before this field existed. Deliberately not the other way round:
        -- making LIVENESS deep is the dangerous mistake, because a liveness
        -- probe that depends on the database restarts the container in a loop
        -- for the duration of a database outage — the restart cannot fix a
        -- dependency, and it destroys the part still working.
        readiness : Optional Readiness
      , probeTiming : ProbeTiming
      , resources :
          --| ⚠ OPTIONAL, because a container that states NO resources is a real
          --  state and the model must be able to say it.
          --
          -- `ircd` forced it: the live container has no `resources` block at all,
          -- and `Resources.requests` is required — so modelling it would have
          -- meant inventing a request for a running pod and restarting it to
          -- match. That is the move `Resources`' own comment calls backwards,
          -- made once already for `limits` when signal's two containers had none.
          --
          -- ⚠ WORKLOAD ONLY. `ScheduledTask` and `Database` keep theirs required:
          -- every live one states resources, so nothing there is being forced.
          Optional Resources
      , volumes : List Volume
      , mounts : List VolumeMount
      , -- Batch work sharing THIS workload's image, uid and root-filesystem
        -- posture. On the workload rather than the namespace because that is
        -- where the sharing is: a scheduled task is the same program with a
        -- different entrypoint. A namespace-level list could not say WHICH
        -- image a task runs once a namespace holds more than one workload, and
        -- picking the first would be a silent answer to a real question.
        tasks : List ScheduledTask
      , -- Further containers in this pod — see `Sidecar`.
        sidecars : List SidecarType
      }

let Workload =
      --| `Workload` as a SCHEMA, so a field that is `None`/empty for almost every
      -- workload costs one line in the ONE file that differs, not fifteen everywhere.
      --
      -- ⚠ A FIELD BELONGS IN `default` ONLY IF ITS DEFAULT IS THE SAFE ANSWER, not
      -- merely the common one. `resources` is absent because a default would let a
      -- model invent numbers for a running pod; `selector` because `spec.selector` is
      -- immutable and deserves an explicit answer at every site.
      --
      -- Each defaulted field's default PRESERVES EXISTING BEHAVIOUR for every
      -- workload that does not mention it: no command override, no distinct
      -- readiness question, no batch work, the kernel doing the chown, and the
      -- pull policy the image kind already implies.
      { Type = WorkloadType
      , default =
        { command = None (List Text)
        , readiness = None Readiness
        , tasks = [] : List ScheduledTask
        , sidecars = [] : List SidecarType
        , volumeOwnership = VolumeOwnership.FsGroup
        , maxBodySize = None Text
        , serviceCheck = None Text
        , pullPolicy = None Text
        , containerName = None Text
        }
      }


let Database =
      --| A MariaDB sidecar database. The engine version lives in `render.dhall`, so
      --  a fleet-wide major bump is one edit instead of six identical ones.
      --
      -- `keys` names the three secret entries the engine needs. They are supplied by
      -- the app (from its declared secret record) rather than hardcoded here, so the
      -- keys MariaDB reads and the keys `secret.sh` writes are the same expressions.
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

let wgAddress
    : Cluster → Text
    =
      --| The WireGuard address of each cluster's node. An app reached over the tunnel
      --  pins its hostPort to one of these, and DERIVES it from `cluster` rather than
      --  repeating it: a hostPort with no `hostIP` DNATs on EVERY address the node has,
      --  including the public one, and a k8s hostPort rule bypasses the NixOS firewall
      --  entirely. Getting this wrong publishes the service.
      λ(c : Cluster) → merge { isis = "10.100.0.2", amun = "10.100.0.1" } c

let Placement =
      --| WHERE a subject runs. One cluster, or several.
      --
      -- ⚠ A MANDATORY HEAD, not a `List Cluster`: an empty list typechecks, renders
      -- no host, and reaches `plan-run deploy` as a tree the model does not place —
      -- the arm that falls back to trusting `--host` (#692).
      --
      -- ⚠ And no `Every` constructor: adding a third cluster would start deploying
      -- onto it with nobody having decided.
      --
      -- The user is the `web` namespace, applied to BOTH clusters. Without this
      -- the model could only say it lived on one, which is false and would make
      -- `plan-run deploy` REFUSE the other cluster.
      { first : Cluster, rest : List Cluster }

let on
    : Cluster → Placement
    =
      --| Runs on exactly one cluster — every subject but `web`, today.
      λ(c : Cluster) → { first = c, rest = [] : List Cluster }

let onBoth
    : Placement
    =
      --| Runs on both. Spelled out rather than derived from a fleet-wide list, for
      --  the reason `Every` was rejected above.
      { first = Cluster.isis, rest = [ Cluster.amun ] }

let placedOn
    : Placement → List Cluster
    =
      --| Every cluster a subject is placed on, head first.
      λ(p : Placement) → [ p.first ] # p.rest

let soleCluster
    : Placement → Cluster
    =
      --| ⚠ The ONE cluster a subject runs on, for the things that cannot mean two.
      --
      -- `wgAddress` is the case: a hostPort's `hostIP` is ONE node's tunnel address
      -- and a subject spanning clusters has no single one.
      --
      -- ⚠ Dhall cannot refuse a multi-cluster subject here. `assert : List/length
      -- Cluster p.rest ≡ 0` fails to TYPECHECK for EVERY subject, because `p` is
      -- lambda-bound and the length never normalises to a literal — `assert` is a
      -- typecheck-time equality on normal forms, not a runtime precondition.
      --
      -- So this takes the head and the obligation moves to dev-lint over the rendered
      -- tree: a `hostIP` must be the tunnel address of the cluster its manifests
      -- deploy to. Same division
      -- `Resources`/`image_profile` already draws, where the type states the shape and
      -- the linter judges what belongs in it.
      --
      -- Nothing hits this today: the only multi-cluster subject is `web`, which has no
      -- workloads at all. The lint is owed before a SECOND one appears.
      λ(p : Placement) → p.first

let SecretKey =
      --| A declared secret key. `apps/*.dhall` builds a record of these and refers to
      --  its fields, which is how a mistyped key becomes a compile error.
      { mapKey : Text, mapValue : Text }


let EgressTo =
      --| One thing an app is allowed to reach, and on which ports.
      --
      -- Addressed by NAMESPACE, not by pod labels: a chart's pod labels change across
      -- versions where `kubernetes.io/metadata.name` is set by Kubernetes itself and
      -- cannot drift.
      { namespace : Text, ports : List { port : Natural, protocol : Text } }


let EgressTo =
      --| One thing an app is allowed to reach, and on which ports.
      --
      -- Addressed by NAMESPACE, not by pod labels: a chart's pod labels change across
      -- versions where `kubernetes.io/metadata.name` is set by Kubernetes itself and
      -- cannot drift.
      { namespace : Text, ports : List { port : Natural, protocol : Text } }

let NetpolPeer =
      --| What NetworkPolicy an app declares, if any.
      --
      -- ⚠ The arms differ in whether they are APPLIED. `IngressFromNginx` renders to
      -- its own `-held.yaml` and stays out of the applied set: kube-router does not
      -- exempt node-sourced kubelet probe traffic, so applying it as written drops
      -- the liveness probes and takes the app down. `Egress` is applied.
      --
      -- A union, not a record of two optionals: no app has both.
      --| One thing a rule may allow traffic TO.
      --
      --   * `Namespace` — every pod in another namespace, by the automatic
      --     `kubernetes.io/metadata.name` label, which Kubernetes sets and chart
      --     labels cannot drift from.
      --   * `Workload` — one workload in THIS namespace, by its `app` label.
      --   * `NamespacedWorkload` — pods in another namespace matching labels.
      --     ⚠ `namespaceSelector` and `podSelector` in ONE peer mean "both must
      --     hold"; two separate peers mean "either", which silently widens a policy.
      --   * `Internet` — an ipBlock of everything except the ranges listed.
      --
      -- ⚠ Whether an `ipBlock` can name the node's own address DEPENDS ON THE PORT,
      -- so re-measure rather than reuse a verdict (#781). A `hostPort` is DNAT'd by
      -- CNI before kube-router's filter rules see it and no ipBlock matches; a port
      -- served by a HOST process has no such rule and one does.
      -- `iptables-save -t nat | grep CNI-HOSTPORT` answers it for a given port.
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
      | --| ONE address, as a CIDR.
        --
        -- `Internet` is the wrong shape for reaching a known host: it can only
        -- say "everything except", so a rule that needs one address ends up
        -- granting the whole internet minus a denylist, and reads to a reviewer
        -- as though that breadth were intended.
        --
        -- ⚠ `why` is required, as it is for `HostPath` and `Unhardened`. An IP
        -- literal in a policy is the one thing here that cannot be read back to
        -- what it means — a hostname would be resolved at render time and frozen
        -- anyway — so the address has to arrive with its reason attached.
        Host : { cidr : Text, why : Text }
      >

let NetpolRule =
      { to : List NetpolPeer
      , ports : List { port : Natural, protocol : Text }
      }

let NetpolTarget =
      --| Which pods a policy governs. `WholeNamespace` renders `podSelector: {}` — a
      --  selector with no terms, which matches EVERY pod in the namespace.
      < WholeNamespace | OneWorkload : Text >

let NetpolPolicy =
      --| A named egress policy. Egress-only by construction, which is not a
      --  simplification: k3s enforces through kube-router, which does not exempt
      --  node-sourced kubelet probe traffic, so a default-deny INGRESS drops the
      --  probes and takes the pod NotReady. Every applied policy in this fleet is
      --  egress, and this type cannot express otherwise.
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

let ConfigMapDoc =
      --| Configuration the app's own container mounts as files.
      --
      -- Key is the filename inside the mount, value its whole contents — a k8s
      -- ConfigMap's `data`.
      --
      -- ⚠ The name is stated here AND at the volume that mounts it. Bind it to a
      -- `let` in the app model so the two cannot drift: a `VolumeSource.ConfigMap`
      -- naming something nobody created is a pod stuck in `ContainerCreating` with
      -- the reason several layers down in an event.
      { name : Text, files : List { mapKey : Text, mapValue : Text } }

let Owner =
      --| A namespace and everything in it.
      --
      -- `App` below is the one-workload case; `namespaceOf` is the embedding.
      --
      -- ⚠ FOUR INVARIANTS THIS TYPE CANNOT STATE, all uniqueness or cardinality
      -- claims over the list, all checked by dev-lint over the rendered manifests:
      --
      --   1. workload names are unique — two sharing a name gives one Service
      --      selecting two different pods, failing as intermittent wrong answers;
      --   2. a NetworkPolicy peer names a workload that exists — one that does not
      --      matches nothing, silently (#781);
      --   3. hostPorts do not collide — the second binder never schedules;
      --   4. one writer per PVC — `Writers.Exclusive` constrains a workload, not a
      --      set of them.
      --| Who creates the namespace this tree deploys into.
      --
      -- `Own` is every tree but one. `Elsewhere` exists because `messages` is a pod
      -- in the `signal` namespace: a `secretKeyRef` cannot cross namespaces.
      --
      -- One statement, four consequences: no Namespace object is rendered, no
      -- `allow-no-netpol` waiver (the owner's tree polices it), nothing may be named
      -- after `name`, and the names that would have been derived are carried here.
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

let Unowned =
      --| A file in the live tree this model does NOT produce, with the reason.
      --
      -- Stating them is what keeps `--check` honest: a manifest the model has never
      -- heard of is a failure, and the only way to make one not a failure is to say so
      -- here, where a reviewer sees it. Same escape hatch as `Durability.LossAccepted`
      -- and it costs the same sentence. Lifted from `site.dhall`, which needed it
      -- first and for the same reason.
      { file : Text, why : Text }

let Labels =
      --| Labels on the Namespace OBJECT ITSELF — not the pod labels a workload derives.
      --
      -- ⚠ **Empty for 13 of the 14 trees, and that is the point.** Only `web` carries
      -- one (`name: web`, redundant with `metadata.name` and selected by NOTHING —
      -- checked in-repo and against the live netpols on isis). It is modelled rather
      -- than stripped because the model's job is to state what the fleet IS; removing
      -- a live label so a type fits is the move this model refuses everywhere else.
      --
      -- A List, not an Optional: empty IS the answer for almost every tree, and
      -- `clusterMeta` maps empty to an ABSENT key, so no manifest gains `labels: {}`.
      List { mapKey : Text, mapValue : Text }


let AcmeDelegation =
      --| A certificate this namespace needs, whose ACME challenge is answered by a
      --  machine that is NOT in this cluster.
      --
      -- `ircd` is the only one, and reading its manifests is what named the concept:
      -- `net.xinutec.irc.yaml` looks like two objects and is one idea. The Ingress
      -- routes NOTHING to the workload — IRC is on hostPorts — so it exists purely to
      -- (a) hold the certificate for its host and (b) hand one path to somebody else.
      --
      -- ⚠ ONE FIELD RENDERS BOTH OBJECTS, and that is the point rather than tidiness.
      -- The `ExternalName` Service's `metadata.name` and the Ingress's
      -- `backend.service.name` are two statements of one name that can drift apart —
      -- `render.dhall`'s own header warns that "an Ingress cannot point at a Service
      -- that was renamed". From one field they cannot disagree.
      { host : Text
      , exposure : Exposure
      , tlsSecret :
          --| Where cert-manager puts the issued certificate. STATED, because the
          --  workload mounts it by name and nothing derives `irc-tls` from `ircd`.
          Text
      , path :
          --| The prefix handed over — `/barfooze`, not `/.well-known`, which the live
          --  manifest records as a deliberate choice in a trailing comment.
          Text
      , forwardTo :
          --| The FQDN that answers the challenge. Outside the cluster by definition;
          --  if it were inside, this would be an ordinary backend and not a delegation.
          Text
      , serviceName :
          --| STATED, not derived. `certbot-forward` is the live name, and deriving
          --  something tidier would rename a live Service and rewrite the Ingress
          --  backend for cosmetics — the rule `vps-pippijn` established: the model
          --  does not get to charge a cluster change for tidiness.
          Text
      , ingressName :
          --| STATED, and this one is not cosmetic at all. cert-manager creates the
          --  Certificate OWNED BY THIS INGRESS (`ownerReferences: Ingress/<name>`),
          --  so renaming the Ingress destroys that Certificate and reissues from
          --  scratch — a live TLS outage for every connected client, to tidy a name.
          --  `ingressNameOf` derives `<namespace>-ingress`, which would rename the
          --  live `irc-ingress` in the `ircd` namespace. Not derivable; stated.
          Text
      , why :
          --| REQUIRED. Handing a path on your own hostname to a third-party host is
          --  exactly the change that must not be addable without saying why, so an
          --  unjustified delegation is unwritable rather than merely discouraged.
          List Text
      }

let Namespace =
      { name : Text
      , owner : Owner
      , placement : Placement
      , db : Optional Database
      , configMap : Optional ConfigMapDoc
      , claims : List Claim.Type
      , workloads : List Workload.Type
      , secrets : List SecretKey
      , netpol : Netpol
      , labels : Labels
      , unowned : List Unowned
      , acme : Optional AcmeDelegation
      , {-| Where this namespace's LIVE manifests sit, relative to `kubes/`,
            when it is not `<name>/k8s`. `None` means the ordinary shape.

            ⚠ **This is read by `plan-run deploy`, not by any renderer** — it
            changes no manifest byte. It exists because the exception used to
            live only in `generate.sh`'s `app_tree()` bash case, so the model
            CHECKED trees the deployer could not reach: `deploy.sh vps-simon`
            died on a directory that does not exist (#1262).

            The same argument as `clusters.json`: a second copy of the mapping
            in the plan's own tables would be two sources of truth for a
            question that already has one, which is the failure #692 was. So
            the model states it and the plan reads what the model renders.
        -}
        tree : Optional Text
      }

let App =
      { name : Text
      , placement : Placement
      , db : Optional Database
      , storage : Optional Storage
      , configMap : Optional ConfigMapDoc
      , workload : Workload.Type
      , secrets : List SecretKey
      , netpol : Netpol
      }

let namespaceOf
    : App → Namespace
    =
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
      λ(a : App) →
        let dataVolumeName = "app-data"

        let claimName = "${a.name}-data-pvc"

        let claimOf =
              λ(s : Storage) →
                { name = claimName
                , storageGi = s.storageGi
                , durability = s.durability
                , writers = s.writers
                , chown = s.chown
                , -- An App's storage never names a class: these trees are
                  -- generated, so none predates the model and k3s's default
                  -- applies. Only hand-written trees carry one.
                  storageClass = None Text
                }

        let claims =
              merge
                { None = [] : List Claim.Type
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

        in    a.{ name, placement, db, configMap, secrets, netpol }
            ⫽ { -- An app IS its namespace: it creates the object and every name
                -- derives from it. So the embedding fills both new fields and no
                -- model file changes, which is what keeps `--check` a proof
                -- about ι rather than a regression test.
                owner = Owner.Own
              , labels = [] : Labels
              , unowned = [] : List Unowned
              , acme = None AcmeDelegation
              , -- An app's tree IS `<name>/k8s`; only a namespace written
                -- directly can need otherwise.
                tree = None Text
              , claims
              , workloads =
                [   a.workload
                  ⫽ { volumes = a.workload.volumes # extraVolumes
                    , mounts = a.workload.mounts # extraMounts
                    }
                ]
              }

in  { Cluster
    , Labels
    , Selector
    , VolumeOwnership
    , Published
    , Placement
    , on
    , onBoth
    , placedOn
    , soleCluster
    , Durability
    , Image
    , imageRef
    , pullPolicyFor
    , EnvValue
    , EnvVar
    , Probe
    , ProbeTiming
    , Readiness
    , standardTiming
    , Quantity
    , Limits
    , Resources
    , ConfigMapDoc
    , VolumeMount
    , VolumeSource
    , Volume
    , fileMode
    , FsGroupChange
    , Claim
    , Writers
    , Storage
    , Hardening
    , RootFs
    , Workload
    , Sidecar
    , ScheduledTask
    , Owner
    , Unowned
    , AcmeDelegation
    , Namespace
    , namespaceOf
    , Database
    , SecretKey
    , Exposure
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
