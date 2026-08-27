let domain =
      -- Every hostname the fleet serves, in one place.
      --
      -- Apps refer to these as record fields (`dns.home`), never as string literals.
      -- That is the whole trick: `dns.hoem` is a type error at render time, so an
      -- Ingress can no longer name a host that was never declared, and the set of
      -- names that must exist in DNS is derivable from this file instead of being
      -- rediscovered by grepping manifests.
      "xinutec.org"

let sub = λ(name : Text) → "${name}.${domain}"

in  { -- Hosts (the machines themselves)
      amun = sub "amun"
    , isis = sub "isis"
    , -- Apps
      coach = sub "coach"
    , dash = sub "dash"
    , fleetwatch = sub "fleetwatch"
    , health = sub "health"
    , home = sub "home"
    , life = sub "life"
    , mail = sub "mail"
    , memview = sub "memview"
    , messages = sub "messages"
    , nocodb = sub "nocodb"
    , slides = sub "slides"
    , tasks = sub "tasks"
    , utterance = sub "utterance"
    , vault = sub "vault"
    , domain
    }
