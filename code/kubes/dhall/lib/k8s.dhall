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

let Probe =
      { httpGet : Optional HTTPGetAction
      , exec : Optional ExecAction
      , initialDelaySeconds : Optional Natural
      , periodSeconds : Optional Natural
      , timeoutSeconds : Optional Natural
      , failureThreshold : Optional Natural
      }

--| A probe with every timing unset; renderers override what they mean.
let emptyProbe =
      { httpGet = None HTTPGetAction
      , exec = None ExecAction
      , initialDelaySeconds = None Natural
      , periodSeconds = None Natural
      , timeoutSeconds = None Natural
      , failureThreshold = None Natural
      }

let ContainerPort = { containerPort : Natural }

let VolumeMount = { name : Text, mountPath : Text, subPath : Text }

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
      , resources : Resources
      }

let Volume = { name : Text, persistentVolumeClaim : { claimName : Text } }

let PodSpec =
      { securityContext : PodSecurityContext
      , containers : List Container
      , volumes : List Volume
      }

--| Every workload in this fleet is selected by a single `app` label. Modelling
--  the selector as a record rather than a free-form map is what makes it
--  impossible for a Service selector and its pod template to disagree.
let Selector = { app : Text }

let Deployment =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { replicas : Natural
          , strategy : Optional { type : Text }
          , selector : { matchLabels : Selector }
          , template : { metadata : { labels : Selector }, spec : PodSpec }
          }
      }

let ServicePort = { port : Natural, targetPort : Optional Natural }

let Service =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { clusterIP : Optional Text
          , selector : Selector
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
      { podSelector : Optional { matchLabels : Selector }
      , namespaceSelector :
          Optional
            { matchLabels : List { mapKey : Text, mapValue : Text } }
      }

let NetworkPolicy =
      { apiVersion : Text
      , kind : Text
      , metadata : Meta
      , spec :
          { podSelector : { matchLabels : Selector }
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
    , Probe
    , emptyProbe
    , ContainerPort
    , VolumeMount
    , ContainerSecurityContext
    , PodSecurityContext
    , Container
    , Volume
    , PodSpec
    , Selector
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
