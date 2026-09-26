let Meta =
      -- The subset of Kubernetes this fleet actually uses, as types.
      --
      -- Only the fields we use, so a misspelled API field (`containerPorts`,
      -- `readinessprobe`) is a type error rather than a key kubectl silently ignores,
      -- and widening the fleet's surface means editing this file.
      --
      -- `--omit-empty` renders Optional fields and empty lists away.
      { name : Text
      , namespace : Optional Text
      , annotations : Optional (List { mapKey : Text, mapValue : Text })
      , -- Labels on the OBJECT, distinct from the pod-template labels a
        -- Deployment selects on. Only the static sites set them, and only on
        -- their Service, where the convention predates this model.
        labels : Optional (List { mapKey : Text, mapValue : Text })
      }

let Quantity = { cpu : Text, memory : Text }

let Limits =
      --| Both halves Optional because the API's are. Fleet POLICY — memory required,
      --  cpu not — lives on `T.Limits`, so it can tighten without this file claiming
      --  the API forbids what it permits.
      { cpu : Optional Text, memory : Optional Text }

let Resources =
      --| Optional because the API's is. Which containers may omit it is decided by
      --  dev-lint's `image_profile`, not here.
      { requests : Quantity, limits : Optional Limits }

let SecretKeyRef = { name : Text, key : Text, optional : Optional Bool }

let EnvVar =
      { name : Text
      , value : Optional Text
      , valueFrom : Optional { secretKeyRef : SecretKeyRef }
      }

let HTTPGetAction = { path : Text, port : Natural }

let ExecAction = { command : List Text }

let TCPSocketAction = { port : Natural }

let Probe =
      { httpGet : Optional HTTPGetAction
      , exec : Optional ExecAction
      , tcpSocket : Optional TCPSocketAction
      , initialDelaySeconds : Optional Natural
      , periodSeconds : Optional Natural
      , timeoutSeconds : Optional Natural
      , failureThreshold : Optional Natural
      }

let emptyProbe =
      --| A probe with every timing unset; renderers override what they mean.
      { httpGet = None HTTPGetAction
      , exec = None ExecAction
      , tcpSocket = None TCPSocketAction
      , initialDelaySeconds = None Natural
      , periodSeconds = None Natural
      , timeoutSeconds = None Natural
      , failureThreshold = None Natural
      }

let ContainerPort =
      --| A hostPort ALWAYS carries its `hostIP` here. A bare hostPort DNATs on every
      --  address the node has, including the public one, and the rule bypasses the
      --  NixOS firewall — so the two are one field pair, never separable.
      { containerPort : Natural
      , hostPort : Optional Natural
      , hostIP : Optional Text
      }

let VolumeMount =
      { name : Text
      , mountPath : Text
      , subPath : Optional Text
      , readOnly : Optional Bool
      }

let ContainerSecurityContext =
      { allowPrivilegeEscalation : Bool
      , readOnlyRootFilesystem : Optional Bool
      , capabilities : { drop : List Text }
      }

let PodSecurityContext =
      --| The three identity fields are Optional because an image whose entrypoint
      --  runs `usermod`/`groupmod` as root crash-loops under `runAsNonRoot`.
      --  `T.Hardening` is where a workload says so.
      { runAsNonRoot : Optional Bool
      , runAsUser : Optional Natural
      , runAsGroup : Optional Natural
      , fsGroup : Optional Natural
      , -- `OnRootMismatch` skips the recursive chown when the volume root is
        -- already group-owned. Only meaningful alongside `fsGroup`, and only the
        -- static sites with a webroot PVC set it today.
        fsGroupChangePolicy : Optional Text
      , seccompProfile : { type : Text }
      }

let Lifecycle =
      --| Only the native `preStop.sleep` action (k8s 1.32+): it needs no binary in
      --  the image, which a distroless or nonroot image may not have.
      { preStop : { sleep : { seconds : Natural } } }

let Container =
      { name : Text
      , image : Text
      , command : Optional (List Text)
      , -- Arguments to the image's own entrypoint, distinct from `command`,
        -- which REPLACES it. Only a database engine uses this: the mariadb
        -- entrypoint takes server flags here, and health-db's 2 GiB InnoDB
        -- buffer pool is one.
        args : Optional (List Text)
      , securityContext : Optional ContainerSecurityContext
      , -- Optional for the same reason `env` and `volumeMounts` are:
        -- `appDeployment` renders WITHOUT `--omit-empty`, so an empty list
        -- would serialise as `ports: []` rather than vanishing. A workload
        -- nothing dials declares none.
        ports : Optional (List ContainerPort)
      , -- Optional, not `List`, for the reason NetworkPolicy's rule lists are:
        -- `appDeployment` renders WITHOUT `--omit-empty` (an `emptyDir: {}`
        -- volume is an empty record that the flag deletes, which would emit a
        -- volume with no source at all), and with the flag off an empty list
        -- serialises as `[]` rather than vanishing. `None` disappears; a list
        -- that is genuinely present stays.
        env : Optional (List EnvVar)
      , volumeMounts : Optional (List VolumeMount)
      , startupProbe : Optional Probe
      , livenessProbe : Optional Probe
      , readinessProbe : Optional Probe
      , lifecycle : Optional Lifecycle
      , -- Optional HERE and required in `T.Workload`, which is the distinction
        -- that matters: every app the fleet BUILDS must state its limits, and
        -- `T.Resources` makes that impossible to omit. The four static sites run
        -- a stock `nginx-unprivileged` with no `resources` block at all and
        -- carry the `allow-no-mem-limit` waiver for it; rendering an invented
        -- limit onto four live pods to satisfy a type would be the model
        -- changing production to flatter itself.
        resources : Optional Resources
      , -- Only ever `Never`, and only for an image that was hand-imported into
        -- containerd rather than pushed to a registry. Left absent otherwise so
        -- the cluster keeps its own default per tag.
        imagePullPolicy : Optional Text
      }

let Volume =
      --| Exactly one of the source fields is set. The API models this as a union of
      --  optional keys and cannot say "exactly one"; `T.Volume` can, and does, so
      --  nothing hand-writes this record.
      --
      -- `emptyDir` renders as `{}` — the empty record, which is the API's way of
      -- saying "default medium, no size limit". `hostPath` states its `type` because
      -- omitting it makes kubelet CREATE a missing path as a directory rather than
      -- fail, so a typo'd mirror path becomes an empty volume that serves 404s
      -- instead of an error anyone would see.
      -- `secret.defaultMode` is Optional and usually should not be: an ssh private
      -- key mounted at the API's default 0644 is refused by ssh itself ("permissions
      -- are too open"), which surfaces as a job that cannot connect rather than as
      -- anything about file modes. It is decimal in the API and octal everywhere a
      -- person writes it, so `T.VolumeSource.Secret` takes the octal and converts.
      { name : Text
      , persistentVolumeClaim : Optional { claimName : Text }
      , configMap : Optional { name : Text }
      , emptyDir : Optional {}
      , hostPath : Optional { path : Text, type : Text }
      , secret :
          Optional { secretName : Text, defaultMode : Optional Natural }
      }

let ConfigMap =
      --| Files served or mounted as configuration. `data` is a map, so the KEY is the
      --  filename inside the mount and the value is its whole contents.
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , data : List { mapKey : Text, mapValue : Text }
      }

let PodSpec =
      { securityContext : PodSecurityContext
      , containers : List Container
      , volumes : Optional (List Volume)
      , -- Absent for a Deployment, where the API's `Always` is the only legal
        -- value. A batch pod must say `OnFailure` or `Never`, and `OnFailure` is
        -- what every one of ours says.
        restartPolicy : Optional Text
      }

let Labels =
      --| The pod a Job runs, plus the two bounds on running it.
      --
      -- ⚠ `activeDeadlineSeconds` is required where the API makes it optional: unset
      -- means a wedged run continues forever, and nothing watches a batch pod, so the
      -- failure is a job still "running" days later with `concurrencyPolicy: Forbid`
      -- suppressing every successor.
      --| The labels that tie a pod template, its Service and its policies together.
      --
      -- A free-form map rather than `{ app : Text }`, because the fleet has two
      -- conventions and ⚠ `spec.selector` is IMMUTABLE — unifying them would mean
      -- deleting and recreating live Deployments.
      --
      -- What stops a Service selector disagreeing with its pod template is not the
      -- record shape but that ONE expression produces the value everywhere it is
      -- needed (`render.dhall`'s `appLabels`, `site.dhall`'s `runLabels`).
      List { mapKey : Text, mapValue : Text }

let JobSpec =
      -- `template.metadata.labels` exists so a job's pods can be SELECTED — by a
      -- NetworkPolicy above all. A CronJob pod otherwise carries only the labels the
      -- API generates (`job-name`, `controller-uid`), none of which name the work, so
      -- the only expressible egress rule for a job is one that covers the whole
      -- namespace. That is how a job that needs to reach one host ends up granting
      -- every pod beside it the same reach.
      { activeDeadlineSeconds : Natural
      , backoffLimit : Optional Natural
      , template : { metadata : { labels : Labels }, spec : PodSpec }
      }

let CronJob =
      --| A CronJob. The three policy fields are required rather than defaulted
      --  because the API's defaults are all wrong for this fleet: `concurrencyPolicy`
      --  defaults to `Allow` (two decodes writing the same rows), and the history
      --  limits to 3/1 — the failed one being the one worth keeping.
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { schedule : Text
          , -- Optional so a running job renders no `suspend:` key at all, which
            -- is what every live manifest looks like. `Some True` is the only
            -- value ever rendered; `Some False` would be noise on five jobs to
            -- state the API's default.
            suspend : Optional Bool
          , concurrencyPolicy : Text
          , successfulJobsHistoryLimit : Natural
          , failedJobsHistoryLimit : Natural
          , jobTemplate : { spec : JobSpec }
          }
      }

let Deployment =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { replicas : Natural
          , strategy : Optional { type : Text }
          , selector : { matchLabels : Labels }
          , template : { metadata : { labels : Labels }, spec : PodSpec }
          }
      }

let ServicePort =
      { port : Natural
      , targetPort : Optional Natural
      , protocol : Optional Text
      }

let Service =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { clusterIP : Optional Text
          , selector : Labels
          , ports : List ServicePort
          }
      }

let ExternalNameService =
      --| A Service that is a DNS CNAME and nothing else.
      --
      -- A SEPARATE TYPE from `Service` rather than optional fields on it, because
      -- the two have no overlap: this one has no selector, no ports and no
      -- clusterIP, and the API server rejects it if given any of them. Modelled as
      -- one record with optionals, every ExternalName service would be a valid
      -- place to write a selector that silently does nothing.
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec : { type : Text, externalName : Text }
      }

let PersistentVolumeClaim =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { accessModes : List Text
          , resources : { requests : { storage : Text } }
          , -- ⚠ IMMUTABLE once the PVC exists, and recorded in
            -- last-applied-configuration, so a manifest that DROPS it cannot be
            -- applied to a live claim — the API server rejects the patch. That
            -- is why it is modelled rather than left implicit: `local-path` is
            -- k3s's default and the field is redundant in EFFECT, but the four
            -- hand-written trees that declare it cannot stop declaring it.
            storageClassName : Optional Text
          }
      }

let Namespace = { apiVersion : Text, kind : Text, metadata : Meta }

let IngressBackend = { service : { name : Text, port : { number : Natural } } }

let IngressPath = { path : Text, pathType : Text, backend : IngressBackend }

let IngressRule = { host : Text, http : { paths : List IngressPath } }

let Ingress =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { ingressClassName : Text
          , tls : List { hosts : List Text, secretName : Text }
          , rules : List IngressRule
          }
      }

let NetworkPolicyPeer =
      --| `matchLabels` is Optional inside the peer for the same reason it is on
      --  `spec.podSelector`: `podSelector: {}` — a selector with no terms — matches
      --  EVERY pod in the namespace, and that is a thing a rule sometimes needs to
      --  say. `netpolDb` says it for an app with batch tasks, whose pods carry no
      --  stable labels of their own.
      { -- CIDR minus exceptions. The only way to say "the public internet",
        -- and NOT a way to say "this node" — see `T.NetpolPeer.Internet`.
        --
        -- ⚠ `except` is Optional, NOT an empty list, and the reason is the same
        -- one that makes this file's rule lists Optional: the NetworkPolicy
        -- renderers run WITHOUT `--omit-empty`, so `[]` serialises as `except: []`
        -- — which the API server then strips. The stored object and the manifest
        -- disagree for ever after, so every `apply.sh` run reports the policy as
        -- `configured` and the drift check cries wolf on an unchanged cluster.
        ipBlock : Optional { cidr : Text, except : Optional (List Text) }
      , podSelector : Optional { matchLabels : Optional Labels }
      , namespaceSelector :
          Optional
            { matchLabels : List { mapKey : Text, mapValue : Text } }
      }

let NetworkPolicyPort =
      --| A port in a NetworkPolicy rule.
      --
      -- ⚠ STATE THE PROTOCOL, even for TCP. It reads like a default worth leaving
      -- implicit and it is not: this list is ATOMIC in the API (no patch merge key),
      -- so `kubectl apply` replaces it whole. A manifest omitting `protocol` sends a
      -- patch that drops the `TCP` the API defaulted in, the API defaults it back, and
      -- the object is reported `configured` on every apply for ever — drift that never
      -- converges and never means anything. `Optional` remains only because UDP has to
      -- be sayable; nothing here should choose `None`.
      { port : Natural, protocol : Optional Text }

let NetworkPolicy =
      --| `podSelector` is `Optional` so an empty selector — the whole namespace, which
      --  is what a default-deny selects — can be expressed at all.
      --
      -- ⚠ `matchLabels: {}` does NOT select nothing — a `LabelSelector` with no terms
      -- matches EVERYTHING. The problem is rendering: under `--omit-empty` an empty
      -- `matchLabels` collapses the whole `podSelector` key away, and a manifest
      -- relying on Go's zero value reads as "no selector stated".
      --
      -- An EMPTY `egress` list is meaningful — with `Egress` in `policyTypes` it
      -- denies all egress — so NetworkPolicy documents render WITHOUT `--omit-empty`.
      --
      -- ⚠ Hence `Optional` for each direction: `None` says this policy is silent
      -- about it and disappears, `Some ([] : ...)` says it is denied outright and
      -- stays. Without that, a bare `ingress: []` would appear and read as a
      -- deliberately empty ingress section.
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { podSelector : { matchLabels : Optional Labels }
          , policyTypes : List Text
          , ingress :
              Optional
                ( List
                    { from : List NetworkPolicyPeer
                    , ports : List NetworkPolicyPort
                    }
                )
          , egress :
              Optional
                ( List
                    { to : List NetworkPolicyPeer
                    , ports : List NetworkPolicyPort
                    }
                )
          }
      }

in  { Meta
    , Quantity
    , Limits
    , Resources
    , SecretKeyRef
    , EnvVar
    , HTTPGetAction
    , ExecAction
    , TCPSocketAction
    , Probe
    , emptyProbe
    , ContainerPort
    , VolumeMount
    , ContainerSecurityContext
    , PodSecurityContext
    , Lifecycle
    , Container
    , Volume
    , ConfigMap
    , PodSpec
    , JobSpec
    , CronJob
    , Labels
    , Deployment
    , ServicePort
    , Service
    , ExternalNameService
    , PersistentVolumeClaim
    , Namespace
    , IngressBackend
    , IngressPath
    , IngressRule
    , Ingress
    , NetworkPolicyPeer
    , NetworkPolicyPort
    , NetworkPolicy
    }
