{-
WHERE A COMMENT MAY SIT, and why every doc block here is BELOW its `let`'s `=`.

`dhall format` deletes most comments. It keeps only those following a token that
opens an expression, measured across thirteen positions on 2026-08-27:

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
      --| The reviewed set the renderer used to hardcode for everything.
      { readiness = { initialDelaySeconds = 5, periodSeconds = 10 }
      , liveness = Some { initialDelaySeconds = 15, periodSeconds = 20 }
      }

let Readiness =
      --| A readiness probe that asks a DIFFERENT question from liveness, with the two
      --  timings a deep probe cannot leave at kubelet's defaults.
      --
      -- ⚠ WHY THIS IS NOT JUST ANOTHER `Probe`. Pointing readiness at an endpoint that
      -- does real work changes what the default timings mean:
      --
      --   * `timeoutSeconds` defaults to 1. A handler that reaches a database can
      --     legitimately take longer than that under load, and at the default kubelet
      --     cuts it off as a probe TIMEOUT — the pod goes NotReady with no status
      --     code, no log line, and no cause named anywhere. Set it ABOVE the handler's
      --     own budget and the failure arrives instead as a 503 the app wrote down.
      --   * `failureThreshold` decides how much slowness is a fault. Withdrawing the
      --     only pod of a single-replica app on one slow answer turns a slow dashboard
      --     into no dashboard, which is worse than what it was reporting.
      --
      -- Both are required rather than optional: a workload writing this field has
      -- already decided the fleet defaults do not fit, so leaving them implicit would
      -- be the one shape that is never right.
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
      { requests : Quantity, limits : Optional Limits }

let VolumeMount =
      --| `readOnly` is stated, not defaulted. A content mirror the app must never
      --  write and a scratch directory it must are the same three fields otherwise,
      --  and only one of them is safe to get wrong quietly.
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
        -- k3s's default StorageClass IS `local-path` (verified on amun
        -- 2026-08-27), so naming it adds a line that says what the cluster
        -- already does.
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
      -- `Secret` mounts an app's own secret as FILES rather than environment. It
      -- exists for material a program insists on reading from a path, with modes it
      -- approves of — an ssh private key is the case that forced it: ssh refuses a
      -- key any other user could read, and the API's default is 0644.
      --
      -- ⚠ `mode` is the API's DECIMAL, because Dhall has no integer division and an
      -- octal-to-decimal conversion here would be several lines of arithmetic doing
      -- the work a name does better. Use [`fileMode`](#fileMode) rather than writing
      -- 384 and hoping the next reader recognises it.
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
      --| Which socket serves an app's hostname.
      --
      -- `Public` is served on the node's public address and on the tunnel.
      -- `VpnOnly` is served on the WireGuard address and NOWHERE ELSE.
      --
      -- ⚠ **THIS BECAME A REAL BOUNDARY ON 2026-09-01 (#1294), AND THE OLD
      -- WARNING HERE IS THE THING THAT CHANGED.** It used to read "VpnOnly is
      -- obscurity at the DNS layer, not a firewall — the ingress still answers
      -- on the public IP for anyone who knows it". That was true while one
      -- shared ingress-nginx answered every name on every address. Host nginx
      -- now emits a `server` block per name whose `listen` addresses come from
      -- this field, so a VpnOnly name has no listener on the public interface
      -- at all. Verified: `vault`, `tasks`, `memview`, `messages` and
      -- `fleetwatch` refuse against the public address while `dash` and `isis`
      -- answer on it.
      --
      -- ⚠ **AND IT IS CHECKED RATHER THAN TRUSTED.** `plan-run frontdoor-check
      -- --vpn-addr` reads the host's generated nginx.conf and fails if a
      -- VpnOnly name appears in a block listening on anything else. The app's
      -- own sign-in wall is no longer the only gate.
      --
      -- Certificates no longer follow from this field: every name is issued by
      -- DNS-01 from `security.acme` on the host, so there is no issuer to
      -- derive. `issuerFor` was deleted with the annotation it fed.
      < Public | VpnOnly >

let Published =
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
      -- The port is NOT a field: it is the workload's own, so the three apps above
      -- cannot name a hostPort that no container is listening on.
      --
      -- ⚠ THE REASON THIS COMMENT USED TO GIVE WAS FALSE, and the correction bounds
      -- what `Reach` can describe. It claimed "a hostPort that disagrees with the
      -- containerPort forwards to nothing, silently". It does not: the CNI portmap
      -- plugin installs a DNAT from the host dport to the container's port, and the
      -- two are free to differ. Checked on amun 2026-08-26 against `vps/irssi`, which
      -- has run 2230 -> 22 for 51 days:
      --
      --     -A CNI-DN-ae12ea... -p tcp --dport 2230 -j DNAT --to-destination 10.42.0.154:22
      --
      -- and the banner answers. So deriving the hostPort from the containerPort is a
      -- POLICY -- one port, named once, for the apps modelled here -- and not the
      -- safety property it was written as. It is also the reason `vps/irssi` and
      -- `ircd` are not expressible: irssi remaps the port deliberately (a per-user SSH
      -- endpoint on a shared node cannot have every user listening on 22), and ircd
      -- publishes three ports from one container where `Workload.port` holds one.
      --| A container port and the node port it is published at.
      --
      -- ⚠ **The two are FREE TO DIFFER**, which this model denied until 2026-08-27.
      -- The CNI portmap plugin DNATs the host dport to the container's port; measured
      -- on amun against `vps/irssi`, running 2230 -> 22 for 51 days. `WireGuard` still
      -- names one number for both, but that is now a POLICY it chooses rather than a
      -- rule the cluster enforces.
      { containerPort : Natural, hostPort : Natural }

let Reach =
      < Ingress : { host : Text, exposure : Exposure }
      | WireGuard
      | -- Published straight onto every node interface, with NO Service.
        --
        -- ⚠ **NOT Kubernetes' `type: NodePort`** — deliberately not named that.
        -- There is no Service at all here; a Service is the thing being avoided.
        --
        -- ⚠ **`hostIP` IS UNSET, and that is the difference from `WireGuard`.**
        -- That arm pins the port to the tunnel address, which is right when the
        -- fleet is the only client. These bind every interface because the
        -- clients are people on the internet with an ssh or IRC client.
        --
        -- A LIST because `ircd` publishes three ports from one container
        -- (6697/7005/7776) and `Workload.port` holds one. `Workload.port` stays
        -- the port the probes ask about, and must be among these.
        --
        -- ⚠ **`why` IS NOT DECORATION — it becomes the dev-lint waiver.** A
        -- hostPort is a real exception (`DL-K8S-HOST-PORT`), and while
        -- `WireGuard` was the only arm its justification was identical
        -- everywhere and could be a constant in `generate.sh`. It no longer is:
        -- these bind the node to see the REAL CLIENT IP, which is a different
        -- reason from tunnel-pinning. `RootFs.Writable` carries a `why` because
        -- three such reasons were already written down and left with the
        -- hand-written YAML they were written in; this is that lesson applied
        -- before the same thing happens again.
        HostPorts : { published : List Published, why : Text }
      | Internal
      | NoService
      >

let RootFs =
      --| Whether the container's root filesystem is read-only.
      --
      -- ⚠ THIS WAS `readOnlyRootFs : Bool`, AND THE `why` IS THE WHOLE POINT. Three
      -- workloads set it `False` — the bridge (a third-party image whose filesystem is
      -- not ours to constrain), the ingester (writes blobs under a mount and uses
      -- /tmp) and irc-tail (copies its ssh key to /tmp at 0400, because a secret
      -- volume is root-owned). Every one of those reasons was already written down.
      -- None of them survived the render: the hand-written YAML carried
      -- `allow-rootfs-rw` markers, `5a00cd49` generated the tree from the model on
      -- 2026-08-14, and the markers left with the file they were written in. dev-lint
      -- has reported all three ever since, correctly, about a decision nobody
      -- disagreed with.
      --
      -- A Bool cannot carry a reason, so the reasons lived in Dhall comments, which
      -- the renderer cannot read. This is `Hardening`'s shape for the same reason
      -- `Hardening` has it: the permissive arm has to be argued, the argument belongs
      -- where the decision is, and the generator can then emit it as the waiver rather
      -- than a human remembering to re-add one.
      --
      -- The default arm carries nothing, so `ReadOnly` stays as cheap to write as
      -- `True` was — thirteen of the sixteen call sites are exactly that.
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
        -- ⚠ health-bus-refresh was found exactly that way on 2026-08-13 —
        -- suspended in the cluster, no `suspend:` in its manifest, and never run
        -- in the 62 days since it was created. A model that omitted the field
        -- would have declared a daily job that does not run, which is worse than
        -- the drift it replaced: it would read as reviewed.
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
        -- purpose, and the CronJob renderer used to emit no volumes at all.
        -- Inheriting the workload's would give a batch job write access to the
        -- long-running pod's data — the ingester's attachment store, say — to
        -- get at a scratch directory it wanted for something else entirely. A
        -- job that needs storage should have to say which.
        volumes : List Volume
      , mounts : List VolumeMount
      }

let Hardening =
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
      < NonRoot | Unhardened : { why : Text } >

let Selector =
      --| Which label key a Deployment selects its pods on.
      --
      -- ⚠ **`spec.selector` IS IMMUTABLE, so this is not cosmetic.** Getting it wrong
      -- is not a re-apply — it is delete-and-recreate, which for these workloads means
      -- dropping a live IRC session or an ssh terminal server.
      --
      -- Two conventions exist here and neither is going away: the app trees derive
      -- `app: <name>`, while `ircd`, `vps-pippijn` and `vps-simon` were written by
      -- hand years earlier and select `run: <name>`. A union rather than free Text,
      -- because these are the only two and a typo'd key typechecks yet cannot be
      -- fixed in place. It is spelled at every workload rather than defaulted: an
      -- immutable field deserves an explicit answer.
      --
      -- ⚠ ONLY the workload's own selector. A database Deployment always derives
      -- `app:` — it is generated, so no live object predates the model.
      --
      -- ⚠ Defined HERE, above `Workload`, because Dhall `let` bindings are ORDERED and
      -- `Workload` uses it. Beside `Labels` further down it is an unbound variable.
      < App | Run >

let VolumeOwnership =
      --| Who makes a mounted claim writable by the process that uses it.
      --
      -- ⚠ **`fsGroup` IS NOT DERIVABLE FROM POSTURE, AND THE OBVIOUS RULE IS REFUTED.**
      -- The renderer used `if anyClaim w then Some w.uid`, which is right for most
      -- trees and wrong for irssi. Measured 2026-08-27 against the live cluster:
      --
      --     workload      hardening     claim   live fsGroup
      --     signal app    Unhardened    yes     1000
      --     irssi         Unhardened    yes     NONE
      --
      -- Both are `Unhardened` with claims and they genuinely differ, so "derive it
      -- from `Hardening`" does not work either. The difference is a fact about the
      -- IMAGE: irssi's entrypoint runs as root and chowns the mounted volumes itself
      -- before dropping to uid 1000, so an `fsGroup` would be redundant. signal's does
      -- not, so it needs one.
      --
      -- ⚠ The exception arm carries `why` for the same reason `Hardening.Unhardened`,
      -- `RootFs.Writable` and `Reach.HostPorts` do: the reason exists today only in
      -- hand-written YAML, and that is exactly how `RootFs`'s three reasons were lost
      -- when their file was generated away.
      --
      -- ⚠ **A THIRD CAUSE, added 2026-08-31 for vaultwarden.** `EntrypointChowns` is
      -- a claim about what the image DOES; borrowing it for a container that simply
      -- runs as root would plant a false statement in the model, and the model is
      -- worth having only because its statements are true. vaultwarden is
      -- `Unhardened` root against a 0777 root-owned volume, so ownership is already
      -- correct and an `fsGroup` would both add a field the live pod does not carry
      -- and trigger a recursive chown of the vault's sqlite DB.
      --
      -- `FsGroup` is the default, so all 15 existing workloads are unchanged.
      < FsGroup
      | EntrypointChowns : { why : Text }
      | RunsAsRoot : { why : Text }
      >

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

            Added 2026-08-31 for vaultwarden, whose live Ingress carries `128m`
            because Bitwarden clients' sync payloads exceed nginx's default.
        -}
        maxBodySize : Optional Text
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
      }

let Workload =
      --| `Workload` as a SCHEMA, so a field that is `None`/empty for almost every
      -- workload costs one line in the ONE file that differs, not fifteen everywhere.
      --
      -- ⚠ **THE FIRST USE OF `{ Type, default }` IN THIS MODEL, so it sets the
      -- convention.** Adopted 2026-08-27 after three fields landed in one day at ~15
      -- edits each (`T.Labels`, `T.Selector`, `Reach.HostPorts`) and a fourth
      -- (`fsGroup`, for irssi) was queued behind the same cost. The conversion is paid
      -- once; every later optional field is one line.
      --
      -- ⚠ **A FIELD BELONGS IN `default` ONLY IF ITS DEFAULT IS THE SAFE ANSWER**, not
      -- merely the common one. `resources` is deliberately ABSENT: nocodb runs with
      -- `resources: {}` live on amun, so a default would let a model quietly invent
      -- numbers for a running pod. `selector` is also absent — `spec.selector` is
      -- immutable, and an immutable field deserves an explicit answer at every site.
      --
      -- ⚠ No count here on purpose: the list below MOVES, and a number in this
      -- sentence rots the moment a field is added — which it did within hours of
      -- being written. The criterion is what matters. Each defaulted field's
      -- default is the answer that PRESERVES EXISTING BEHAVIOUR for every
      -- workload that does not mention it: no command override, no distinct
      -- readiness question, no batch work, the kernel doing the chown, and the
      -- pull policy the image kind already implies.
      { Type = WorkloadType
      , default =
        { command = None (List Text)
        , readiness = None Readiness
        , tasks = [] : List ScheduledTask
        , volumeOwnership = VolumeOwnership.FsGroup
        , maxBodySize = None Text
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
      -- ⚠ **A RECORD WITH A MANDATORY HEAD, NOT A `List Cluster`**, because "runs
      -- nowhere" must not be writable. An empty list typechecks, renders no host, and
      -- would reach `plan-run deploy` as a tree the model does not place — which is
      -- the arm that falls back to trusting `--host`, i.e. exactly the #692 defect the
      -- cluster model exists to close. The head being required makes the bad state
      -- unrepresentable rather than caught later, which is this file's whole method.
      --
      -- ⚠ **AND NOT AN `Every` CONSTRUCTOR.** "Wherever there are clusters" reads as
      -- the convenient answer and is the dangerous one: adding a third cluster would
      -- start deploying every `Every` subject onto it with nobody having decided.
      -- Naming the clusters means growing the fleet is a deliberate edit to each
      -- subject that should follow it — the same reason `plan-run.nix` pins a revision
      -- instead of tracking `main`.
      --
      -- The first user is the `web` namespace, which is applied to BOTH clusters
      -- today: identical `last-applied-configuration` on isis and amun, checked
      -- 2026-08-26. Before this existed the model could only say it lived on one, so
      -- the model stated something false and modelling it would have REFUSED the
      -- deploy to the other cluster.
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
      -- ⚠ **DHALL CANNOT REFUSE THIS, AND AN `assert` HERE IS WORSE THAN NOTHING.**
      -- Tried 2026-08-26: `assert : List/length Cluster p.rest ≡ 0` inside this
      -- function fails to TYPECHECK for every subject, not just multi-cluster ones,
      -- because `p` is lambda-bound so the length never normalises to a literal.
      -- Dhall's `assert` is a typecheck-time equality on normal forms, not a runtime
      -- precondition — the whole model stopped building. The idea that it would "fire
      -- only on the path that needs it" was a description of what I wanted.
      --
      -- So this takes the head, and **the obligation moves to dev-lint over the
      -- RENDERED tree**: a `hostIP` must be the tunnel address of the cluster its
      -- manifests actually deploy to. That is a decidable predicate over rendered YAML
      -- with the deploy map beside it, which is a linter's job — the same division
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
      { name : Text, files : List { mapKey : Text, mapValue : Text } }

let Owner =
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
