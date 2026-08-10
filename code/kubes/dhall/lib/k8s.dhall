-- The subset of Kubernetes this fleet actually uses, as types.
--
-- Only the fields we use are here, deliberately. Two consequences:
--
--   * a misspelled API field (`containerPorts`, `readinessprobe`) is a type
--     error at render time instead of a silently-ignored key that kubectl
--     accepts and does nothing with;
--   * reaching for a field that isn't modelled forces a decision in this file,
--     which is where a reviewer can see the fleet's surface area grow.
--
-- Optional fields are rendered away by `dhall-to-yaml-ng --omit-empty`, as are
-- empty lists, so an app with no volumes emits no `volumes:` key at all.
let Meta =
      { name : Text
      , namespace : Optional Text
      , annotations : Optional (List { mapKey : Text, mapValue : Text })
      , -- Labels on the OBJECT, distinct from the pod-template labels a
        -- Deployment selects on. Only the static sites set them, and only on
        -- their Service, where the convention predates this model.
        labels : Optional (List { mapKey : Text, mapValue : Text })
      }

let Quantity = { cpu : Text, memory : Text }

let Resources = { requests : Quantity, limits : Quantity }

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

--| A probe with every timing unset; renderers override what they mean.
let emptyProbe =
      { httpGet = None HTTPGetAction
      , exec = None ExecAction
      , tcpSocket = None TCPSocketAction
      , initialDelaySeconds = None Natural
      , periodSeconds = None Natural
      , timeoutSeconds = None Natural
      , failureThreshold = None Natural
      }

--| A hostPort ALWAYS carries its `hostIP` here. A bare hostPort DNATs on every
--  address the node has, including the public one, and the rule bypasses the
--  NixOS firewall — so the two are one field pair, never separable.
let ContainerPort =
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
      { runAsNonRoot : Bool
      , runAsUser : Natural
      , runAsGroup : Natural
      , fsGroup : Optional Natural
      , -- `OnRootMismatch` skips the recursive chown when the volume root is
        -- already group-owned. Only meaningful alongside `fsGroup`, and only the
        -- static sites with a webroot PVC set it today.
        fsGroupChangePolicy : Optional Text
      , seccompProfile : { type : Text }
      }

let Container =
      { name : Text
      , image : Text
      , command : Optional (List Text)
      , securityContext : ContainerSecurityContext
      , ports : List ContainerPort
      , env : List EnvVar
      , volumeMounts : List VolumeMount
      , startupProbe : Optional Probe
      , livenessProbe : Optional Probe
      , readinessProbe : Optional Probe
      , -- Optional HERE and required in `T.Workload`, which is the distinction
        -- that matters: every app the fleet BUILDS must state its limits, and
        -- `T.Resources` makes that impossible to omit. The four static sites run
        -- a stock `nginx-unprivileged` with no `resources` block at all and
        -- carry the `allow-no-mem-limit` waiver for it; rendering an invented
        -- limit onto four live pods to satisfy a type would be the model
        -- changing production to flatter itself.
        resources : Optional Resources
      }

let Volume =
      { name : Text
      , persistentVolumeClaim : Optional { claimName : Text }
      , configMap : Optional { name : Text }
      }

--| Files served or mounted as configuration. `data` is a map, so the KEY is the
--  filename inside the mount and the value is its whole contents.
let ConfigMap =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , data : List { mapKey : Text, mapValue : Text }
      }

let PodSpec =
      { securityContext : PodSecurityContext
      , containers : List Container
      , volumes : List Volume
      }

--| The labels that tie a pod template, its Service and its policies together.
--
-- A free-form map rather than a fixed `{ app : Text }` record, because the fleet
-- has two conventions and neither can be changed: the apps select on `app`, and
-- the static sites under `web/` select on `run`. **A Deployment's
-- `spec.selector` is immutable** — the API rejects an edit — so rewriting the
-- sites to `app` would mean deleting and recreating four live Deployments.
--
-- What stops a Service selector disagreeing with its pod template is NOT the
-- record shape: it is that one expression (`render.dhall`'s `appLabels`,
-- `site.dhall`'s `runLabels`) produces the value everywhere it is needed. The
-- shape only ever documented the convention; the derivation is the guarantee.
let Labels = List { mapKey : Text, mapValue : Text }

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

let PersistentVolumeClaim =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { accessModes : List Text
          , resources : { requests : { storage : Text } }
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
      { podSelector : Optional { matchLabels : Labels }
      , namespaceSelector :
          Optional
            { matchLabels : List { mapKey : Text, mapValue : Text } }
      }

let NetworkPolicy =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { podSelector : { matchLabels : Labels }
          , policyTypes : List Text
          , ingress :
              List
                { from : List NetworkPolicyPeer
                , ports : List { port : Natural }
                }
          }
      }

in  { Meta
    , Quantity
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
    , Container
    , Volume
    , ConfigMap
    , PodSpec
    , Labels
    , Deployment
    , ServicePort
    , Service
    , PersistentVolumeClaim
    , Namespace
    , IngressBackend
    , IngressPath
    , IngressRule
    , Ingress
    , NetworkPolicyPeer
    , NetworkPolicy
    }
