let irssi = ../irssi.dhall

in  irssi
      { user = "pippijn"
      , hostPort = 2230
      , -- ⚠ SLOWER THAN READINESS ON PURPOSE. Copying readiness's
        -- `initialDelaySeconds = 5` would crash-loop it: 16s to Ready on one
        -- start and 31s on the next, so 3 failures at 5/15/25 kills at ~25s.
        liveness = Some { initialDelaySeconds = 30, periodSeconds = 10 }
      }
