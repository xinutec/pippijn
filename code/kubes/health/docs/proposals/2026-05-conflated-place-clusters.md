---
status: active
created: 2026-05-21
updated: 2026-05-21
---

# Proposal — disambiguating co-located places by time-of-day

## Problem

`refresh-focus-places.ts` mines `focus_places` from ~180 days of
PhoneTrack history (`detectStays` → `clusterStays` → `classifyCluster`
+ `assignDisplayNames` + an amenity vote); `velocity.ts` then labels a
day's stationary stay by scoring it against those `focus_places`
(`pickBestPlace`). Three structural choices combine to mislabel a place
badly when distinct places sit close together:

1. **Clustering fuses neighbouring places.** `clusterStays` merges any
   stays whose centroids fall within `CLUSTER_RADIUS_M = 150 m`. Two
   genuinely different places less than ~150 m apart collapse into one
   `focus_place` — one centroid, one label.

2. **A place is named only by the venues around it.** The amenity vote
   asks `nearbyLandmarks` for the best named venue within 100 m of each
   visit and tallies a dwell-weighted vote. A residence has no
   `amenity`/`shop`/`tourism`/`leisure` tag and is often not a mapped
   building, so it can never win the vote.

3. **"Residential" is defined solely by Fitbit sleep.** Both the mining
   (`refresh-focus-places.ts`, `RESIDENCE_SLEEP_THRESHOLD_H = 5`) and
   the runtime (`velocity.ts` `isResidential = sleepHours >= 5`) decide
   a place is a residence only when ≥5 h of Fitbit-confirmed sleep
   overlapped its stays. A residence the user visits in the *evening*
   and then leaves to sleep elsewhere has `sleep_hours = 0` — it is
   invisible as a residence to every part of the system.

## Evidence

The 2026-05-20 golden day reconstructed one such cluster:

- One `focus_place`, `frequent`, `uniqueDays = 14`, ~34 h dwell —
  actually **two** real places ~115 m apart: a café and a residence the
  user visits repeatedly, mostly in the evening (and the café a few
  times, in the daytime).
- `clusterStays` (150 m) merged café-visits and residence-visits; the
  amenity vote landed on the café. (`pickBestLandmark` also ranks the
  café's `amenity` tag above a closer park's `leisure` tag regardless
  of distance — `osm.ts` `LANDMARK_PRIORITY` sorts by type before
  distance — so residence-side visits whose GPS noise drifts within
  100 m of the café vote café too.)
- At runtime, `velocity.ts:531` stamps the merged place's
  `amenity_label` ("the café") onto the evening stay, because the
  place's `sleep_hours = 0` fails the `isResidential` gate.

A naive cluster split does **not** fix this (see next section): the
split-out residence lobe still has `sleep_hours = 0` and its nearest
"venue" is a park — so it would simply be relabelled from the café to
the park. The bug is not one mis-pick; it is three reinforcing gaps.

## Relation to the paused weighted-place-accumulation proposal

`2026-05-weighted-place-accumulation.md` (paused, fully reverted) covers
adjacent ground; its hard-won constraints bound this proposal:

- Its **§6 "split fused multi-venue clusters"** proposed splitting on
  *space and visit character* — "dwell length, time-of-day, frequency".
  §6 was *not* the cause of that proposal's revert (§5's mined-kind
  namer was, golden 0/6). This proposal lifts §6 — and keeps its
  behavioural half: time-of-day is the spine here, not an afterthought.
- **Do not** mine `P(kind)`/`P(dwell|kind)` naming — dwell is censored
  by the 10-minute `STAY_MIN_DURATION_SEC` floor; the model came out
  flat. This proposal does no cross-cluster kind/dwell mining. The
  time-of-day *profile* below is a per-place aggregate (like the
  existing `sleep_hours`), not a kind model.
- **Do not** accuracy-weight a centroid — reverted, not outlier-robust.
  This proposal sub-clusters the existing median stay centroids only.
- That proposal concluded a *guaranteed* place name needs a signal from
  outside GPS/Fitbit — "a one-time user confirmation" — and put it out
  of scope. Design 7 takes it up; it is the right fix for an
  evening-only residence, which §3 of Problem shows the system cannot
  classify on its own.

## Why a clean cluster split is not enough

Splitting the merged cluster into a café `focus_place` and a residence
`focus_place` is necessary but, alone, does not fix the user-visible
bug — for two runtime reasons:

- **The runtime cannot tell the two apart by distance.** `pickBestPlace`
  scores a stay against every `focus_place` with a Gaussian on distance
  whose σ floor reaches 100 m — `place-prior.ts` deliberately widened it
  there to tolerate 100–200 m of day-of GPS scatter. Two `focus_places`
  115 m apart are within ~1 σ; the distance term separates them by well
  under one log-point. Which wins is then decided by the frequency/time
  priors on a thin, noise-fragile margin — not robustly by geometry.

- **Even when the runtime picks the residence lobe, it still mislabels
  it.** A naively split residence lobe still has `sleep_hours = 0`
  (evening-only). Its amenity vote, run at the residence centroid,
  picks the nearest park; and even with no `amenity_label`,
  `velocity.ts`'s reverse-geocode runs with `preferResidential: false`
  (the sleep-based `isResidential` gate is false), and `bestPlace`
  returns that same park landmark before any address. Either path lands
  on the park. The café label becomes a park label — still wrong.

So the fix is a set: split the cluster, *and* give the runtime a signal
that robustly separates two co-located places, *and* stop a venue-less
lobe from taking a venue label.

## Principle

Separate before naming; **time-of-day is the signal that separates
co-located places where 115 m of space cannot** — a café visited in the
daytime and a residence visited in the evening are cleanly bimodal in
time even when spatially fused. Use it in both directions: to split a
conflated cluster (mining) and to route a stay to the right place
(runtime). Do not try to infer "this is a residence" without sleep —
that is the unreliable inference the paused proposal burned on; gate the
label so it is never confidently wrong, and let the user pin the name.

## Design

### 1. A time-of-day profile on each focus_place

Give every `focus_place` an hour-of-day dwell profile: a small fixed
histogram (e.g. 24 buckets, or coarser) of how that place's total dwell
distributes across the local-solar hour of day, mined from its stays.
Stored as one compact column; recomputed every nightly refresh, so it
stays a pure function of raw history (no accumulator). It generalises —
and replaces — the current binary sleep/awake time signal
(`sleep_hours` vs `awake_hours`): "overnight" and "weekday daytime" both
fall out of the histogram. Schema change: one column on `focus_places`
(cheap — the table is DELETE+INSERT-rebuilt nightly).

### 2. Split a conflated cluster on the joint (space, time-of-day)
distribution

After `clusterStays`, run a `splitCluster` pass on each cluster:

- Represent each member stay by its median centroid **and** its
  time-of-day, standardised (z-scored) so the split is not hostage to
  an arbitrary metres-per-hour weighting. Time-of-day is circular —
  represent it so 23:00 and 01:00 are near (e.g. as a unit-circle
  angle).
- Test the member stays for bimodality with a **model-selection**
  criterion — fit one component vs two and accept two only when it
  clearly beats one (silhouette / gap-style margin) — not a hard
  sub-radius cliff. A genuine single noisy place is unimodal and the
  test rejects the split.
- Split only when the two components are each *substantial* (≥ a small
  visit-day floor — enough to reject splitting off a single outlier
  visit, low enough not to fold a real 3–4-visit café lobe into the
  residence) and are separated by a real margin in space **or**
  time-of-day.

Because café-daytime and residence-evening are ~6–8 h apart in
time-of-day, the joint distribution is clearly bimodal even though the
~115 m spatial gap alone is marginal. The split is therefore robust
*because* it does not depend on the spatial gap — that is the whole
point of carrying the temporal dimension.

### 3. Runtime: time-of-day discrimination in `pickBestPlace`

`scorePlaceForSegment` (`place-prior.ts`) gains a time-of-day term:
score the stay's own time-of-day against each candidate `focus_place`'s
profile (Design 1). This generalises the present `logPriorTime`
(`isSleepWindow ? log(sleepHrs+1) : log(awakeHrs+1)`) into a proper
hour-of-day match. It is what lets the runtime route an evening stay to
the residence `focus_place` over the café `focus_place` when the two are
co-located and the distance term (σ ≈ 100 m) cannot separate them —
without retightening σ, which exists to tolerate genuine day-of
scatter. The term's weight is bounded, like the existing `logPriorFreq`:
enough to break ties between co-located candidates, not enough to
override strong distance evidence (a matching profile 2 km away must not
beat the place the user is standing in).

The hour-of-day term subsumes the present `logPriorTime` outright —
"overnight" and "weekday daytime" are both regions of one histogram,
which strictly carries more information than the sleep/awake binary.
The Home/Work *label* is untouched (`velocity.ts` short-circuits on
`display_name` before any scoring), but the *routing* between a home and
a co-located office must stay at least as separable under the histogram
as under the binary — pinned by a no-regression test (see Testing).

### 4. `pickBestLandmark`: distance-aware type priority

`osm.ts` `pickBestLandmark` sorts by `LANDMARK_PRIORITY` (`amenity` >
`leisure` > …) *before* distance, so a café 95 m away outranks a park
5 m away. Make the priority distance-aware: a higher-priority type
outranks a lower-priority one only when it is not dramatically farther
(within a modest absolute + ratio margin); beyond that, distance wins.
This removes the spurious café votes that residence-side visits cast
today. Small, OSM-data-independent, and independently shippable.

### 5. Confidence-gate the venue label, and resolve a gated place to an
address

Two parts — a mining gate, and the runtime routing it implies.

**Gate (mining).** When a cluster's best landmark evidence is weak —
only `leisure`/`place` types within range, or the nearest `amenity` is
beyond a tight distance ("near a venue", not "at it") — store **no**
`amenity_label`. (The "vote never cleared `minFraction`" case is
*already* a null `amenity_label`; the gate's new behaviour is only the
type-quality and distance conditions.) This applies the paused
proposal's "honesty gate" to the existing vote — no new model.

**Runtime routing.** A null `amenity_label` is necessary but not
sufficient: `velocity.ts` then reverse-geocodes via `bestPlace`, and
`bestPlace` with `preferResidential: false` returns the nearest landmark
— the park — *before* its address fallback. `velocity.ts` currently
picks `preferResidential` from the sleep-based `isResidential` gate,
which an evening-only residence (`sleep_hours = 0`) fails. So the
runtime must, for a place the gate marked venue-less, reverse-geocode
preferring an address (`preferResidential: true`) regardless of
`isResidential` — the gate signal ("no confident venue here") is itself
the reason to prefer an area/address over a low-confidence nearby
landmark. The split-out residence lobe then shows a neutral area label,
not the park.

### 6. Opening-hours as a soft vote signal

A supplementary signal in the amenity vote — explicitly *not* a gate:

- When a visit votes a venue, consult its OSM `opening_hours` tag —
  already mirrored in `tags_json`, no schema change. Evaluate it at the
  visit's local-solar time, consistently with `localSolarHour`.
- If `opening_hours` is present **and** a conservative parser
  confidently finds the venue *closed* at that time → drop that visit's
  vote. If the tag is absent or the parser cannot confidently evaluate
  it → vote unchanged. Missing or complex data is never penalised; the
  parser bails to "unknown" on anything it cannot evaluate.
- If dropping closed-venue votes leaves a cluster with no votes,
  `pickWinningAmenity` returns null and the place is unnamed — the
  intended outcome, handled by Design 5's fallback.

With good OSM data this strips obviously-wrong votes (evening "visits"
to a café that shuts at 18:00); with no data it is inert. OSM
`opening_hours` coverage is partial and improvable, so this sharpens the
café side but is never load-bearing.

### 7. Manual labels — the definitive name for an evening-only residence

Problem §3: the system's only notion of "residential" is Fitbit sleep,
and an evening-only residence has none. Inferring "residence" from
"frequent + long evening dwell + no venue" is exactly the kind/inference
the paused proposal showed is unreliable — this proposal does not
attempt it. The honest fix is the external signal that proposal named
and deferred: let the user pin a name to a place.

- The runtime honours a manual label above every automatic label
  (above `amenity_label`, above the Home/Work `display_name`).
- A manual label must survive the nightly DELETE+INSERT rebuild of
  `focus_places`, so it cannot key on the regenerated row id: store it
  in a separate `place_labels` table keyed on a stable geo identity
  (rounded centroid / geohash) and matched back by proximity each
  refresh. **Depends on task #80 (stable focus_places identity).**

Until a place is manually labelled, Designs 2+3+5 ensure it at least
shows a neutral area/address — never a confidently-wrong venue.

## Why the full split, not the cheaper label-only fix

Design 4 + Design 5 alone — without the cluster split (Design 2) or the
runtime term (Design 3) — would stop the *wrong label*: residence-side
visits would stop voting café, and a fused cluster with only weak venue
evidence would be gated to a neutral label. That is materially less
code. But it leaves the café and the residence **fused in one
`focus_place`**: their visit counts, dwell and time-of-day stay
conflated, the place has one blended centroid, and there is no separate
residence row for the user to manually name. The user wants the
residence recognised as its own place — so the split is warranted. The
cheaper fix is noted here as the fallback if Design 2 proves
unreliable in practice.

## Phasing

- **Phase 1 — the bug fix.** Designs 1 + 2 + 3 + 5, plus Design 4.
  After Phase 1 the café and residence are separate `focus_places`, the
  runtime routes a stay to the right one by time-of-day, and the
  residence shows a neutral area label rather than a wrong venue.
  Designs 1–3 are one coherent unit — the split (2) does not fix the
  bug without the runtime term (3); Design 4 is independently
  shippable and could land first as a quick win.
- **Phase 2 — opening-hours soft signal (Design 6).** Sharpens the
  café-side vote; degrades gracefully to a no-op without data.
- **Phase 3 — manual labels (Design 7).** Gives the residence its
  definitive name. Depends on task #80.

## Testing

- **Golden harness.** 2026-05-20 is a golden day; the relabel surfaces
  as a reviewable golden diff to re-bless.
- **`splitCluster` unit tests.** The critical case is the no-regression
  one — a single GPS-noisy place must *not* split — alongside a
  café+residence two-lobe cluster that must, and an asymmetric case
  (one large lobe, one 3–4-visit lobe) that must split without folding
  the small lobe away.
- **Real-data fixture, end-to-end.** Cluster splitting is a
  messy-geometry algorithm; synthetic tests gave false-green for
  rail-snap three times. Capture the real conflated café+residence
  stays and assert not just the split but the *runtime* outcome: an
  evening residence-side stay resolves to the residence (neutral
  label), a daytime café-side stay to the café.
- **`scorePlaceForSegment` unit tests** for the time-of-day term: two
  co-located candidates with opposite hour-of-day profiles, where an
  evening stay must pick the evening one; **and** a Home-vs-Work
  no-regression case — an overnight-profile candidate and a
  weekday-daytime-profile candidate must still route an overnight stay
  and a daytime stay correctly, no worse than the binary sleep/awake
  prior did.
- **Opening-hours parser** unit tests: open / closed /
  unparseable→unknown.

## Residual limits

- Two places that are *both* spatially marginal **and** temporally
  overlapping will not split — Design 5's gate and Design 7's manual
  label are the backstop.
- OSM `opening_hours` coverage is partial; Design 6 helps only where
  the data exists.
- The system cannot classify an evening-only residence on its own, by
  design — its correct *name* comes from the manual label. Auto-detecting
  "residential" without sleep is deliberately not attempted.

## Risks

- **Over-splitting a single noisy place** — mitigated by the
  model-selection test (not a radius cliff) and the substantiality
  floor, pinned by the no-regression unit test and the golden harness.
- **The runtime time-of-day term overpowering distance** — mitigated by
  a bounded weight, validated by the co-located-candidates unit test.
- **`opening_hours` parser complexity** — mitigated by conservative
  bail-to-unknown parsing and soft (drop-vote-only) application.
- **Manual-label persistence** is blocked on task #80; Phase 3 cannot
  ship until that lands.
