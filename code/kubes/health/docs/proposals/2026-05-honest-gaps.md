---
created: 2026-05-24
updated: 2026-05-24
status: design
---

# Honest gaps — multi-modal clustering + `unknown` for unobserved time

## Problem

`findStays` and `inferTransitGaps` both fabricate specific labels over
periods of sparse data. Three concrete instances on blessed days:

- **04-30, 12:34 – 19:37 AMS**: one stationary segment `@ Plein 1944
  187`. Ground truth is four distinct stays (Bairro Alto, parents'
  flat, café, unidentified dinner spot) all within ~500 m of each
  other in central Nijmegen.

- **04-30, 19:37 – 22:35 AMS**: "walking on Burgemeester
  Hustinxstraat" at 0.1 km/h for nearly 3 hours. There are no fixes
  for 2 h 22 m before Vertoef arrival; the user was stationary
  somewhere we can't observe.

- **04-29, 18:48 – 22:13 AMS**: a 3 h 25 m "walking" arc through the
  Nijmegen arrival period. Mix of real walking and signal gaps.
  Today's pipeline merges it into one long walking segment.

The two architectural shortfalls:

1. **`findStays` uses a single median centroid + 150 m radius**. When
   the day's fixes form multiple distinct spatial clusters (Bairro
   Alto vs parents' vs café vs dinner spot), the median picks one
   cluster and drops the others as outliers, leaving the dropped
   stops invisible to the rest of the pipeline. The 04-30 output of
   "one stay @ parents' for 7 hours" is the visible symptom.

2. **`TransportMode` has no `unknown` value**. Every period must
   commit to a movement-or-stationary mode. When implied speed across
   a long no-fix gap is below walking pace, the algorithm picks
   "walking" rather than acknowledging the data is too sparse to
   say. The 04-30 phantom 3 h 0.1 km/h walk is the visible symptom.

## Algorithm

Two complementary changes.

### Change A — trajectory-segmented `findStays`

Replace the single-cluster median+radius approach with **time-ordered
trajectory segmentation**.

Walk the in-gap points in time order, maintaining a running cluster:

```
cluster = []                   # current running cluster of fixes
for fix in inGap (time-ordered):
    if cluster is empty:
        cluster = [fix]
    else if distance(fix, centroid(cluster)) <= CLUSTER_RADIUS_M:
        cluster.append(fix)
    else:
        emit_stay_if_valid(cluster)
        cluster = [fix]
emit_stay_if_valid(cluster)
```

A cluster becomes a stay when it has ≥ 2 fixes and a time-extent
≥ 15 min — same threshold as today.

`CLUSTER_RADIUS_M = 100`. Tighter than today's `STAY_RADIUS_M = 150`
because the radius now bounds a single coherent place rather than a
day-wide blob.

For 04-30 this produces: Bairro Alto stay (09:11–10:17 UTC), parents'
stay 1 (10:34–13:40), café stay (14:46–15:16), parents' stay 2
(15:31–17:17), Vertoef stay (20:35–21:48). Five stays. Three of the
six ground-truth stops surface directly; the remaining one (dinner
cluster 4 at 17:31–19:50 AMS) sits inside the window-classifier's
walking segments (the user was moving around the restaurant area at
that time, evidenced by 25 dense fixes) — recovering it is a separate
algorithmic move (longer-stationary-during-walking detection).

For dense-fix days (05-12 / 05-14 / 05-15 / 05-18 / 05-20 / 05-22)
this change is mostly a no-op — every visit on those days has dense
in-cluster fixes that the old median-centroid approach already
clustered correctly. Verified day-by-day below.

### Change B — `unknown` mode for sub-walking-pace long gaps

Add a sixth `TransportMode` value: `"unknown"`.

In `inferTransitGaps`, when the implied speed across a gap is below
walking pace **and** the gap is long, replace the walking branch with
an `unknown` segment:

```
if speedKmh < SLOW_GAP_MAX_SPEED_KMH (1.5)
   and gapDuration >= SLOW_GAP_MIN_DURATION_S (30 * 60):
    mode = "unknown"
else if speedKmh < 7:
    mode = "walking"
...
```

For 04-30 this replaces the 2 h 22 m phantom 0.1 km/h walk with one
`unknown` segment.

For 04-29 this replaces the 3 h 25 m phantom walk through the
Nijmegen arrival period — same class.

For dense-fix days this change is also mostly a no-op — gap inferences
on those days have implied speeds at vehicle / walking pace, not sub-
walking-pace; the new threshold doesn't fire.

### What `unknown` looks like downstream

- `EnrichedSegment` for an unknown segment carries
  `pointCount: 0`, `avgSpeed: 0`, `confidence: 0.1`,
  `refinedReason: "no GPS coverage"`. Downstream OSM enrichment,
  biometric correction, and the factor scorer already skip synthetic
  gap segments on `pointCount === 0`; the new `unknown` mode rides
  that same path.

- `src/sleep/day-state.ts` emits an `unknown`-mode state with a
  hedged label like `"no GPS signal"`.

- Frontend timeline renders unknown segments with a muted style
  distinguishing "we don't know what happened here" from a positive
  movement claim.

## Why this shape

- **Trajectory segmentation is well-understood**. Greedy time-ordered
  proximity clustering is the standard "trajectory segmentation by
  spatial change" algorithm. DBSCAN-style would handle the same
  cases at similar complexity; greedy wins on debuggability (each
  emit point is traceable to a specific cross-radius transition).

- **Outlier-tolerant by design**. A single bad GPS fix mid-cluster
  starts a 1-point "cluster" that fails the ≥ 2 fixes / ≥ 15 min
  threshold and gets dropped. The surrounding cluster continues
  with the next-in-radius fix.

- **Decomposed cleanly**. Both changes are structural emission rules
  in the candidate generator — binary detection rules, not soft
  weights on classifications. Matches the
  [[feedback-layer2-rules-must-decompose]] pattern.

- **Doesn't touch the classifier**. refineMode / factor scorer /
  biometric correction are unaffected.

- **Reversible per-day**. If a future improvement (e.g. recovering
  movement from cell-tower history) provides evidence across an
  apparently-blank gap, `unknown` segments can become real-mode
  segments again without schema migration.

## Expected behaviour-change matrix

| Day      | Today's output (relevant span)                       | After this change                                                         |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| 04-29    | walking 18:48 – 22:13 AMS (3 h 25 m phantom)         | `unknown` for the no-fix portion; real walking where fixes exist          |
| 04-30    | one stationary @ Plein 1944 187 for 7 h              | Bairro Alto → parents' → café → parents' → … (4–5 distinct stays)         |
| 04-30    | walking 19:37 – 22:35 AMS (3 h, 0.1 km/h)            | `unknown` for the 2 h 22 m no-fix portion                                 |
| 05-11    | dense day                                            | unchanged                                                                 |
| 05-12    | dense day                                            | unchanged                                                                 |
| 05-14    | dense day                                            | unchanged                                                                 |
| 05-15    | dense day                                            | unchanged                                                                 |
| 05-18    | dense day                                            | unchanged                                                                 |
| 05-20    | dense day                                            | unchanged                                                                 |
| 05-22    | dense day                                            | unchanged                                                                 |

The dense-day "unchanged" claim is the load-bearing one — Change A is
a behaviour shift, and we need confidence it doesn't perturb days
that currently look right. The verification path is: run the goldens,
expect 04-29 + 04-30 to diff, expect every other day to be
byte-identical. If any dense day diffs, investigate before re-blessing.

## What this does NOT address

- **Dinner cluster 4 on 04-30** (17:31 – 19:50 AMS). The
  window-classifier sees the 25 dense fixes during this period as
  movement (walking-around inside the restaurant or its
  neighbourhood). Recovering this as a stay requires a different
  rule — "long contiguous low-displacement walking → stationary
  with movement-inside-place". Separate algorithmic move, not in
  scope.

- **Brief unidentified stop on 04-30 cluster 5** (19:56 – 20:13 AMS,
  16 m, only 2 fixes). Too brief to surface confidently. Out of
  scope.

- **Place-naming after the new stays are created**. The new café and
  east-Nijmegen stays will hit `pickBestPlace` and probably resolve
  to whatever address the OSM nearest-address lookup picks. Fixing
  the label quality is downstream of fixing the segment count
  (#173 / #185). The honest-gaps change just makes more stays
  exist; it doesn't directly improve their labelling.

- **05-22's precision issues** (same-line train coalesce, sliver
  merge, brief-stay POI commitment, slow-taxi-as-walking). Separate
  algorithmic moves, not in scope here.

## Test plan

TDD via `tests/scenarios/sparse-day-honest-gaps.test.ts`:

1. **Synthetic — trajectory split**: a hand-built point series with
   three distinct spatial clusters (150–300 m apart) interleaved in
   time. Assert `classifySegments` produces ≥ 3 stationary stays at
   the expected clusters.

2. **Synthetic — outlier tolerance**: a mostly-stationary cluster
   with one bad-GPS outlier fix. Assert the outlier doesn't split
   the cluster — output is one stationary stay.

3. **Synthetic — unknown for slow-long gap**: two clusters 300 m
   apart with a 2 h no-fix gap. Assert no slow-and-long walking
   segment exists; assert at least one `unknown` segment covers the
   gap.

4. **Real fixture — 04-30 multi-modal**: replay
   `tests/fixtures/days/2026-04-30-pippijn.json`. Assert ≥ 3
   stationary stays in the 12:34 – 19:37 AMS central-Nijmegen window
   (today: 1). Assert at least one `unknown` segment in the pre-
   Vertoef gap.

All assertions fail under today's code; all must pass under the new
code.

Golden harness post-implementation: dense days must stay byte-
identical; 04-29 + 04-30 will diff and need re-blessing against the
ground-truth narratives.

## Files modified

- `src/geo/segments.ts` — `findStays` replaced with trajectory-
  segmentation; `inferTransitGaps` gains unknown branch;
  `TransportMode` adds `unknown`. Two new constants
  (`CLUSTER_RADIUS_M`, `SLOW_GAP_MAX_SPEED_KMH`,
  `SLOW_GAP_MIN_DURATION_S`).
- `src/sleep/day-state.ts` — handle `unknown` mode.
- `frontend/src/app/components/timeline/*` — render `unknown` with
  hedged styling.
- `tests/scenarios/sparse-day-honest-gaps.test.ts` — synthetic + real
  fixture tests.
- Any code path that switches exhaustively on `TransportMode` —
  audit and add an `unknown` arm (likely just exhaustiveness checks;
  classifier code skips on `pointCount === 0`).

## Open question for Pippijn

The 04-29 narrative says "18:48 – 22:13 the Nijmegen arrival period
— Vertoef checkin, dinner, etc. Some real walking and some signal
gaps." For the algorithm to do the right thing here, it'd help to
know roughly: was the arrival actually a continuous *walking around
Nijmegen* + dinner experience (so the right output is walking +
dinner-stay + walking), or was it dominated by sitting at Vertoef +
restaurant (so the right output is two stays bracketing a brief
walk)? Either is fine to encode — but the algorithm's expected
output for this window depends on which is closer to truth.
