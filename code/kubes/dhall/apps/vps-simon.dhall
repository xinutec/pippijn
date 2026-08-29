let irssi = ../irssi.dhall

in  irssi
      { user = "simon"
      , hostPort = 2231
      , -- ⚠ NONE because the live deployment has none, not because it should
        -- not have one. See `irssi.dhall` — adding it rolls the pod, and this
        -- bouncer must not be rolled while Simon is not attached.
        liveness = None { initialDelaySeconds : Natural, periodSeconds : Natural }
      }
