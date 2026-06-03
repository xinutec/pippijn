---
created: 2026-06-03
updated: 2026-06-03
status: design
references:
  - 2026-06-magnetic-focus-places.md
  - 2026-05-conflated-place-clusters.md
  - 2026-05-weighted-place-accumulation.md
  - 2026-05-physical-plausibility.md
---

# Cross-day presence continuity — established stays persist across
# sparse-data days

## Problem

`computeVelocity` decodes each day **independently** from raw GPS,
biometrics, and a static focus_places snapshot. Sparse-data days
within an established stay get the same independent treatment as a
fresh travel day. This produces an unphysical labelling regression
the user sees directly:

- 2026-05-25 (rich data): admitted to Cleveland Clinic London → day
  labels correctly as `@ Cleveland Clinic London` (or near-misses on
  the OSM POI lookup, fixable via the magnet)
- 2026-05-26 through 2026-06-01 (Owntracks frequency turned down):
  fewer fixes per day, some days with zero or near-zero fixes. The
  same hospital bed. Day labelling drifts to `@ Stay`, `@ unknown`,
  or worse.
- 2026-06-02 (discharge taxi home): the leaving-day decodes correctly
  again from rich movement data.

The user-visible bug: "fewer points shouldn't make things worse after
some time." From a Bayesian standpoint they are exactly right —
seven days of confirmed presence at place X should be an overwhelming
prior for day eight's labelling, regardless of GPS density. The
current per-day decode discards that prior entirely.

The magnetic-focus-places work (shipped 2026-06-03) addresses a
within-day version of this — noisy fixes that drift toward a
geometrically-close OSM POI get pulled back toward an established
focus_place. But the magnet only fires when *some* fix is within its
radius. A day with no fixes near the hospital — or no fixes at all —
gets no magnet.

## Principle

A stay at a known place is the stable state. Continuation is the
default; ending it requires positive evidence. The Bayesian frame:
`P(at place X on day N+1 | at place X on day N, no contradicting
evidence) ≈ 1`. When evidence is genuinely absent, "still at X" is
the rational posterior — not "unknown" and certainly not "drifted
to a nearby playground."

This generalises the within-day magnetic anchoring (spatial pull from
focus_place centroids) to a temporal pull across days: an
established stay persists forward in time until movement evidence
breaks it.

## Relation to prior work

- **`2026-06-magnetic-focus-places.md` (shipped).** The magnet
  anchors *individual fixes* spatially to known focus_places. This
  proposal anchors *day-level presence* temporally to established
  stays. Same principle — strong prior pulls noisy posterior —
  one axis apart.

- **#186 sleep-place asymmetric trust + #189 next-day fallback
  (shipped).** Already does cross-day inheritance, but only for
  *sleep windows* and only for *named known places* via
  `detectKnownPlaceStays`. The narrow shape: sleep crossing midnight
  inherits its place from morning fixes on the next calendar day,
  or evening fixes on the previous one. This proposal generalises
  the same idea — "presence persists across daily boundaries when
  evidence agrees" — to *waking hours* and to *any established stay*,
  not just sleep + focus_places.

- **`2026-05-conflated-place-clusters.md` (shipped Phase 1).** Adds
  time-of-day discrimination to focus_place attribution. Orthogonal
  to this proposal: the within-day spatial pick is unchanged; this
  adds a temporal continuity layer over multi-day presence.

- **`2026-05-weighted-place-accumulation.md` (paused, fully
  reverted).** Burned on:
  - Reported-accuracy-as-weight (not outlier-robust). This proposal
    doesn't use reported accuracy.
  - Dwell-by-kind mining from a 10-min-censored stays table. This
    proposal mines no new features.
  - Incremental accumulator (lost reproducibility). The hard
    constraint: **don't fold history opaquely into an accumulator.**
    The presence summary in this proposal is a *pure function* of a
    bounded raw-history window, fully recomputed on a nightly cadence
    — identical pattern to focus_places. No daily-incremental state.

## Design

### 1. The presence_log table

A new persisted table, one row per (user, date), storing the
day-level "presence summary":

```sql
CREATE TABLE presence_log (
  user_id     VARCHAR(64) NOT NULL,
  date        DATE        NOT NULL,
  tz          VARCHAR(64) NOT NULL,
  -- The day's dominant presence: the focus_place id (when an
  -- established stay covers most of the day) or null (a travel
  -- / mixed day). Stored as id, not coords, to survive
  -- focus_places re-mining.
  dominant_place_id   BIGINT NULL,
  -- Fraction of waking hours (0-1) accounted for by dominant_place_id.
  -- 1.0 = entire day at one place. < 0.5 = a mixed / travel day.
  dominant_fraction   FLOAT NOT NULL,
  -- The last established stay's centroid + tz before the day ended.
  -- Used by the next day's decoder as the "presumed at" seed when
  -- direct evidence is absent. Recorded from the day's last
  -- stationary segment with confidence ≥ threshold.
  end_of_day_place_id BIGINT NULL,
  end_of_day_confidence FLOAT NOT NULL,
  computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, date)
);
```

DELETE+INSERT rebuilt nightly from a bounded backfill window (e.g.,
last 30 days), in the same cron that refreshes focus_places. Pure
function of (raw fixes, focus_places snapshot, current code).

### 2. The continuity decoder pass in velocity.ts

A new pass in `velocity.ts`, late in the pipeline (after HSMM
override and the final merge from #183-class fixes), inspects the
day's segment output for **continuity gaps**:

```
gap shape:                            response:
last segment ends at X (mined         emit a continuation stay
focus_place), then no further         segment for the gap covering
segments for ≥ 30 min, AND the        the rest of the day; mark
prior day ended at X                   confidence = prior_day_confidence
                                       × time_decay(gap_duration)

no segments AT ALL for the day,       emit one whole-day "presumed at
AND prior day ended at X              X" stay segment; confidence per
                                       above

last segment ends at X, next day's    no change today; the next day's
first fix is at Y ≠ X                  decoder handles its own seed
```

The decoder reads `presence_log[user_id, date - 1]` to find the
"end_of_day place" seed. If that exists AND no fix in today's data
contradicts (i.e., no movement segment with displacement > 1 km from
X, and no stationary segment whose centroid is ≥ 500 m from X), the
continuation fires.

### 3. Contradiction signals

A continuation does *not* fire if today's data shows positive
evidence of being elsewhere. Specifically any of:

- A stationary segment whose centroid is ≥ 500 m from the prior day's
  end_of_day centroid
- A movement segment with sustained speed > 5 km/h covering > 1 km
  net displacement
- A sleep window whose GPS centroid (when available) is ≥ 500 m from
  the prior day's end_of_day centroid

These match the magnetic-focus-places detachment logic — actual
movement breaks the magnet within a day, and the same evidence
breaks the temporal continuation across days.

### 4. Confidence decay

A continuation's confidence decays with time-since-last-confirmed-fix.
Concretely:

```
confidence = prior_day_confidence · exp(-hours_since_last_fix / TAU)
```

with `TAU ≈ 24 hours`. So after 24 h of no-evidence-either-way, the
continuation has ~37% of the prior day's confidence; after 48 h,
~14%. This bounds how far a continuation can drift forward without
fresh confirmation — a five-day Owntracks-off period gets a stay
attribution that's progressively less confident, and after ~72 h the
confidence is low enough that the UI renders it as "likely at X"
rather than confidently "at X." Per the project quality bar
(`probabilistic-principles.md`): honest low-confidence beats
fabricated precision.

### 5. The user-visible UI affordance

A continuation segment renders with the same place label as its
seed, but with a confidence indicator (already partially shipped via
#170: confidence-gated venue label). Suggested label form for the
end-user:

- `Cleveland Clinic London` (high confidence, recent fix
  confirms)
- `Cleveland Clinic London · likely` (medium confidence, last
  confirming fix > 24 h ago)
- `Cleveland Clinic London · presumed` (low confidence, last
  confirming fix > 48 h ago)

For internal debugging / `analyze-day`, the segment can carry an
explicit `refinedReason: "presence continuation from 2026-05-26"`
so the human can audit what the decoder did.

### 6. What this does NOT do

- **No per-fix imputation.** A continuation segment is a single
  whole-window stay attribution, not a sequence of synthesised
  individual fixes. The raw fix stream is untouched.

- **No look-ahead to future days.** The continuation only uses
  `presence_log[date - 1]` and earlier — strictly causal. Tomorrow's
  GPS doesn't retroactively influence today's attribution.
  Exception: the next day's first-fix-elsewhere does still
  contradict the prior day's continuation if it's < 6 h after the
  prior day's last fix, because that's effectively a continuous
  trajectory the day boundary happens to cut through. Handled
  symmetrically by the existing sleep-place backward fallback (#189).

- **No new mining of focus_place features.** `presence_log` is
  derived from the existing per-day decode + the existing
  focus_places snapshot. No dwell-by-kind, no accuracy-weighted
  centroids — the failure modes of the paused proposal stay out of
  reach.

- **No incremental accumulator across days.** `presence_log` is
  DELETE+INSERT rebuilt nightly from raw history within a 30-day
  window. Change the algorithm, re-run, everything updates. Same
  reproducibility constraint as focus_places.

## Phasing

- **Phase 1 — `presence_log` table + nightly cron.** Schema +
  computation. Pure offline; no runtime impact yet. Captures the
  data so we can audit "what would the continuation say" without
  changing any visible output.

- **Phase 2 — read-only `presence_log` in velocity.ts.** When the
  day has a low-density or absent stay pattern, log a diagnostic
  comparing what the per-day decode produces vs what a continuation
  would produce. No user-visible change. Lets us calibrate the
  thresholds (500 m, TAU, etc.) against real data before any
  attribution shift.

- **Phase 3 — emit continuation segments behind a flag.** The new
  pass actually runs and attaches its segments when
  `useContinuityContinuation` is on. Goldens compare both paths.
  Hospital-stay days (Cleveland Clinic 05-26 through 06-01)
  should label correctly under this flag; existing goldens should
  stay unchanged.

- **Phase 4 — UI confidence rendering.** Surface `likely` /
  `presumed` qualifiers in the timeline. Depends on Phase 3
  landing.

## Worked example — Cleveland Clinic 8-day stay

Day 05-25 (rich data, admission):
- Pipeline: stationary @ Cleveland Clinic London 16:18–23:59,
  sleeping @ Cleveland Clinic London 23:55–07:53
- `presence_log[2026-05-25]`: dominant_place = Cleveland Clinic id,
  dominant_fraction = 0.6, end_of_day_place = Cleveland Clinic id,
  confidence = 0.95

Day 05-26 (sparse data, ~30 fixes, all near hospital):
- Per-day decode: detects a stationary stay at noisy centroid;
  magnet pulls to Cleveland Clinic; emit "stationary @ Cleveland
  Clinic London" ≥ partial coverage
- Continuation pass: prior day ended at Cleveland Clinic; no
  contradiction signals today (no movement, no stay > 500 m off);
  fill gaps with continuation segments at Cleveland Clinic,
  confidence = 0.95 · exp(-24/24) = 0.35 → renders as `Cleveland
  Clinic London · likely`
- `presence_log[2026-05-26]`: same

Day 05-29 (zero fixes — Owntracks fully off):
- Per-day decode: no segments emitted (no fixes to cluster)
- Continuation pass: prior day's end was Cleveland Clinic
  (`likely`); no contradictions because no contradicting evidence
  exists; emit one whole-day continuation segment at Cleveland
  Clinic with confidence = 0.35 · exp(-96/24) = 0.006 → renders as
  `Cleveland Clinic London · presumed`
- This is the honest answer. The system is saying: "we have no
  fresh evidence either way, but our prior is strongly Cleveland
  Clinic, so that's our best guess at low confidence."

Day 06-02 (discharge):
- Per-day decode: drives away from hospital, ends at Home →
  contradiction signal fires (movement > 1 km), continuation does
  not extend
- `presence_log[2026-06-02]`: dominant_place = Home, end_of_day =
  Home; the chain reseeds

## Testing

- **Real-data fixture: the Cleveland Clinic stay.** Capture
  05-25 through 06-02 as a multi-day fixture. Assert: every day's
  daytime hours render as `Cleveland Clinic London` (with varying
  confidence). The discharge day labels correctly as drive + Home.

- **Synthetic regression — continuity must not cross a real move.**
  Two-day fixture: day 1 stays at place X, day 2 has a clear
  morning drive to place Y followed by all-day stay at Y. The
  continuation pass MUST NOT extend X into day 2.

- **Confidence-decay sanity.** A continuation entering its third
  no-evidence day must score < 0.1 confidence (matches the
  `presumed` UI threshold).

- **No-regression on the 9 existing goldens.** None of them are
  multi-day stays; the continuation pass should be a no-op on each.

## Residual limits

- **First-time stays.** The continuation only applies once a place
  is established. A user's FIRST visit to Cleveland Clinic — when
  it isn't yet a mined focus_place AND there's no prior-day
  presence to inherit — gets the standard per-day decode, with the
  magnet as the only help. This is correct: continuation requires
  established evidence to inherit.

- **Travel through known places.** Driving from Home to Work passes
  near the Met Line tube route which is a known way. The
  continuation pass operates on per-day end-states, so brief
  pass-through doesn't poison anything — the next day's seed is
  the EVENING's end-state, not noon's. Same logic as the existing
  sleep-place fallback.

- **The user explicitly being elsewhere with no recorded fixes.**
  If the user travels somewhere else but their phone is off, the
  continuation will misattribute. The contradiction signal can't
  fire without data. This is the unavoidable failure mode of any
  continuity-based inference; the confidence decay limits the
  damage but doesn't eliminate it. The honest reading on the UI
  becomes the user's first-line check ("does the `presumed`
  label match what I actually did?").

## Risks

- **Over-extension of presence.** Mitigated by confidence decay
  (TAU = 24 h) and the contradiction signals. Validated by the
  synthetic regression and the multi-day Cleveland Clinic
  fixture.

- **Stale `presence_log` after a focus_places re-mining.** The
  table stores focus_place IDs; if a focus_place is re-mined into
  a different id, lookups fail. Mitigated by the nightly rebuild:
  the table is recomputed every day, so stale IDs from a prior
  algorithm version only live until the next nightly run. Same
  guarantee as the existing focus_places pipeline.

- **Cron failure leaves yesterday's data missing.** If the nightly
  cron fails, today's continuation pass has no `presence_log[date -
  1]` to read. The decoder falls back to per-day decoding as
  today — graceful degradation, not a crash.
