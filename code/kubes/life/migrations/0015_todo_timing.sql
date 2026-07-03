-- Optional timing on a to-do: a start-gate and a deadline. Both DATE (day
-- granularity — hour-level reminders stay delegated to NC Calendar, per the
-- design's "no scheduling subsystem" boundary).
--   not_before: don't surface / can't act before this day — the "waiting" gate,
--               which doubles as snooze ("not this week").
--   due:        the deadline; drives the list's urgency ordering.
-- NULL on either = unset (no gate / no deadline).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS not_before DATE NULL,
                  ADD COLUMN IF NOT EXISTS due        DATE NULL;
