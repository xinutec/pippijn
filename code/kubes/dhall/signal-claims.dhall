-- The claims the `signal` namespace owns.
--
-- A file of their own, and not for tidiness: `kubes/signal` CREATES them and
-- `kubes/messages` MOUNTS one, so a claim is the first thing in this model that
-- two trees have to agree about. Restating it in the second tree would work
-- until one of the two changed.
--
-- ⚠ `T.VolumeSource.Claim` carries the whole claim rather than its name — Dhall
-- has no `Text/equal` and the Prelude is off-limits here (a remote import would
-- make rendering need the network), so a name could not be resolved back to the
-- claim it refers to. That is what makes this file necessary rather than merely
-- neat: the mounting tree needs the claim VALUE, not a string.
--
-- Sits beside `dns.dhall` rather than under `apps/`, which `generate.sh` globs —
-- a data file in there would be rendered as an app and fail.
let T = ./lib/types.dhall

--| signal-cli's linked-device keys and account state.
--
-- ⚠ SECRET-CLASS: whoever holds it can impersonate the linked device, so its
-- odin backup is sensitive. `LossAccepted` anyway, and the reason is not
-- indifference — the device can be re-linked from the phone, where a restore of
-- these keys onto a second running instance would be a second device claiming to
-- be the same one.
--
-- Not shared: only `signal-cli-rest-api` mounts it. It lives here because the
-- two claims of one namespace belong in one place, not because anything else
-- reads it.
let cli
    : T.Claim
    = { name = "signal-cli-pvc"
      , storageGi = 2
      , durability =
          T.Durability.LossAccepted
            { why = "linked-device keys; re-link from the phone instead" }
      , writers = T.Writers.Exclusive
      , chown = T.FsGroupChange.Always
      }

--| Downloaded attachment blobs, keyed by attachment id.
--
-- ⚠ MOUNTED BY TWO WORKLOADS AND TWO TREES: the ingester writes it, and the
-- `messages` viewer in `kubes/messages` mounts it read-only. That is why
-- `Writers` is `Concurrent` and why claims belong to the NAMESPACE rather than
-- to a workload. RWO holds because both pods land on the one node.
let attachments
    : T.Claim
    = { name = "signal-attachments-pvc"
      , storageGi = 20
      , durability =
          T.Durability.LossAccepted
            { why = "re-downloadable from Signal while the messages remain" }
      , writers =
          T.Writers.Concurrent
            { why = "one writer (ingester) and one reader (messages, readOnly)" }
      , -- 20 Gi of blobs. Re-chowning them at every pod start buys nothing —
        -- the root already carries the right group after the first mount.
        chown = T.FsGroupChange.OnRootMismatch
      }

in  { cli, attachments }
