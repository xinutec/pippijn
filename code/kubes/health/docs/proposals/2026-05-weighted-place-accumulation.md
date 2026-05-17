---
status: active
created: 2026-05-17
updated: 2026-05-17
---

# Proposal — weighted, accumulating focus-place centroids

## Problem

The focus-places pipeline (`refresh-focus-places.ts` → `focus-places.ts`)
locates each recurring place by clustering PhoneTrack stays, and labels it
by the nearest OSM venue. Three design choices make it fragile when venues
are densely packed:

1. **Per-fix accuracy is a binary gate, not a weight.**
   `detectFocusPlaces` (`focus-places.ts:456`) hard-drops any fix with
   `accuracy > 200 m`, then treats every surviving fix as equal. Observed
   per-fix accuracy at a single dense-urban place ranged **1 m to 329 m**
   (median 42 m) — a 300× spread the equal-weight mean throws away.

2. **Centroids are median / dwell-weighted, never accuracy-weighted.**
   A stay's centroid is the *median* of its fixes (`detectStays`); a
   cluster's centroid is the *dwell-weighted* mean of its stay centroids
   (`accumulateStay`, `focus-places.ts:170`). Neither uses the accuracy
   signal, so a handful of precise fixes carry no more pull than a crowd
   of noisy ones.

3. **The 180-day window is too short.** `refresh-focus-places` fetches
   the last 180 days and DELETE-rebuilds `focus_places` each run. A place
   visited ~12×/year gets only ~6 visits in that window — half its
   annual data — so its centroid never converges. The DELETE-recompute
   itself is correct and kept (see Design §4); the window *length* is
   the bug.

The amenity-label mining compounds (1)+(2): it picks one nearest venue
*per stay* from that stay's noisy centroid and majority-votes. When
several venues sit within GPS error of each other, the per-stay picks
scatter across them and the vote has no majority — or a stale low-visit
snapshot picks the wrong neighbour.

## Evidence

A recent investigation reconstructed one mislabelled cluster — a café
labelled as an adjacent clinic ~58 m away, in a parade where ~7 OSM
venues sit within 12 m of the cluster centroid. Running the real
pipeline over a year of history:

- All near fixes, plain mean → centroid **33 m** from the café.
- Stationary-only fixes, plain mean → **30 m**. Filtering by "moving"
  barely helps: transition fixes near a sit-down stay are not wild
  outliers.
- Stationary fixes, **inverse-variance (1/accuracy²) weighted** →
  **13 m from the café, 46 m from the clinic.** The weighted centroid
  lands on the right venue and clearly rejects the wrong one.

The remaining error is visit-to-visit scatter: RMS 31 m across ~12
visits → standard error of the pooled mean ≈ 10 m, shrinking as 1/√N.
A place visited daily reaches ~1 m precision purely by accumulation; a
place visited ~monthly is stuck near 10 m — not from an unbeatable
bias, but because it has not accumulated enough visits across enough
conditions (satellite geometry, time of day) for the correlated error
component to average down.

Conclusion: the math already works — we throw away the two things that
make it work. We gate accuracy instead of weighting by it, and we window
history instead of accumulating it.

## Principle

Weight, don't filter. Recompute, don't accumulate. Use every fix,
discounted by confidence; rebuild `focus_places` in full from a bounded
raw-fix window each run, so it stays reproducible from code.

## Design

### 1. Per-fix weight

Each fix gets `w = w_acc · w_still`:

- `w_acc = 1 / max(accuracy, FLOOR)²` — inverse-variance. `accuracy =
  null` gets a conservative default σ. The existing `> 200 m` filter at
  `focus-places.ts:456` is **retained**: a fix with accuracy that poor
  can also be wildly mis-*positioned*, and a single such fix inside a
  stay window fragments stay *detection* — a structural break weighting
  cannot undo. Within the surviving 5–200 m range a 200 m fix already
  carries ~100× less weight than a 20 m one, so the filter is near-inert
  for the centroid; it earns its place purely as a stay-detection
  outlier guard.
- `w_still ∈ (0, 1]` — a soft factor from Fitbit (low steps + HR present
  → ~1; clearly moving → small but non-zero). A moving fix is still weak
  position evidence: down-weight it, don't drop it. The evidence shows
  `w_acc` is the dominant lever; `w_still` is a minor refinement, and it
  needs Fitbit data threaded into the otherwise-pure `focus-places.ts` —
  so it is deferred to Phase 3. **Phase 1 implements `w_acc` only.**

### 2. Weighted centroids

- Stay centroid → weighted mean of its fixes (replaces the median).
- Cluster centroid → weighted mean of **all fixes across all stays**:
  `Σ w·lat / Σ w`. Equivalent to maintaining `(Σw, Σw·lat, Σw·lon)`.

### 3. Amenity label from the pooled centroid

Replace the per-stay `pickBestLandmark` + majority vote with a single
pick (or distance-weighted venue score) from the cluster's pooled
weighted centroid. One converged estimate, one decision.

### 4. A 365-day rolling window, fully recomputed

Widen the lookback from 180 to 365 days; keep the existing
DELETE-and-recompute. A full year captures a place's complete annual
visit cycle — a daily place gets 365 visits and converges to ~1 m; a
place visited monthly converges to its annual-visit-count precision
(~10 m) and no further.

Deliberately **not** an incremental accumulator. A stored running
`(Σw, Σw·lat, Σw·lon)` folding in new fixes would let centroids keep
improving past one year — but it freezes every past contribution under
whatever weighting and algorithm were current when it was folded in.
`focus_places` would stop being reproducible by running the code over
raw fixes; old data becomes opaque "golden" state. Full recompute over
a bounded raw-fix window keeps `focus_places` a pure function of (raw
PhoneTrack history, current code): change the algorithm, re-run,
everything updates. Reproducibility outweighs unbounded convergence.

## Phasing

- **Phase 1 — weighting (`w_acc` only).** Items 1–3: accuracy-weighted
  stay + cluster centroids; pooled-centroid amenity pick. Relabels
  dense-venue clusters correctly. TDD: a scenario test with synthetic
  fixes around two close venues — a precise cluster on venue A plus a
  noisy spread toward venue B — asserting the weighted centroid resolves
  to A. No schema change.
- **Phase 2 — widen the window.** Item 4: `DEFAULT_LOOKBACK_DAYS`
  180 → 365. A one-line change; ships alongside Phase 1.
- **Phase 3 — optional.** `w_still` + Fitbit-confirmed stay *detection* —
  thread Fitbit steps/HR into the pipeline as a stationarity signal,
  both as a centroid weight and inside `detectStays`.

## What this does not solve

Weighting sharpens the *centroid*; it does not separate venues closer
together than the converged precision. After many visits a centroid is
good to a few metres — enough to distinguish venues tens of metres
apart, not metres apart. And the stay-clustering radius merges genuinely
distinct venues (a café and a clinic in one parade) into a single
cluster, so one cluster can legitimately host visits to several venues.
Venue-level disambiguation within a cluster needs a different signal —
visit duration / time-of-day priors, or manual place pinning — and is
out of scope here.
