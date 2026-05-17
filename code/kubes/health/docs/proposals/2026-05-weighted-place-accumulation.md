---
status: active
created: 2026-05-17
updated: 2026-05-17
---

# Proposal — weighted, accumulating focus-place centroids

## Problem

The focus-places pipeline (`refresh-focus-places.ts` → `focus-places.ts`)
locates each recurring place by clustering PhoneTrack stays, and labels it
by the nearest OSM venue. Four design choices make it fragile when venues
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

4. **Naming is a single nearest-node lookup.** The label is the nearest
   OSM venue to the cluster centroid. That treats OSM as ground truth
   for *identity* — but OSM POI nodes are imprecisely placed (often
   10–20 m off the real shopfront), sometimes mis-tagged (a coffee shop
   tagged `fast_food`), and ambiguous where venues pack within GPS
   error. One geometric lookup is far too weak to carry "what is this
   place", and it uses none of the cluster's behavioural history.

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

**Update — Phase 1 shipped.** With weighted centroids live, the example
cluster's centroid moved from 80 m to **14 m from the café and 45 m
from the clinic** — the clinic mislabel is gone, exactly as predicted.
But the label then landed on a **fast-food outlet** whose OSM node sits
~8 m from the converged centroid — nearer than the café's node at
~14 m. The user has never visited that outlet. This is the naming
defect (Problem §4): the centroid is now right, but a nearest-node pick
among venues packed within GPS error is a coin-flip, and it ignores
that a dozen long weekday-morning visits are wildly implausible for a
fast-food counter. Phase 4 addresses it.

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

### 5. Multi-signal candidate-scored naming (Phase 4)

Phase 1 fixes *where* the cluster is; it does not fix *what it is*. A
correct centroid still gets a coin-flip nearest-node label (Problem §4,
Evidence update). Replace the nearest-node pick with a scored candidate
set: take **every** OSM venue within range as a candidate, and score

  `score(v) = w_dist(v) · w_type(v)`

- `w_dist(v)` — a *soft* distance falloff (Gaussian, σ ≈ the cluster's
  positional uncertainty, ~10–15 m) from the weighted centroid to `v`.
  Soft, not nearest-wins: a venue 14 m out is not crushed by one 8 m
  out when both sit inside the error bar.
- `w_type(v)` — the *user's own* historical propensity for `v`'s kind of
  venue. OSM's `subtype` gives the kind (café / fast-food / clinical /
  …) and is trusted verbatim — it is a language-neutral controlled
  vocabulary. The weight is mined each refresh from how the user's
  out-of-home dwell time splits across kinds: a user who spends far more
  time in cafés than fast-food gives café-kind venues a much higher
  `w_type`. Behavioural data, not a hand-tuned or language-dependent
  assumption.

This makes the user's history do the *naming*, not just the
positioning. The string "café" is never in the user's GPS data — but
the *pattern of where they spend time* is, and a per-user kind prior
distils it.

OSM tags are trusted as given: no name-string second-guessing, which
cannot be done language-neutrally. A genuine OSM mis-tag (a coffee shop
tagged `fast_food`) is an upstream data bug to fix in OSM, not to paper
over with locale-specific heuristics in our code.

**Honesty gate.** When the top candidate's score does not clearly beat
the runner-up, the place is *ambiguous*. Rather than commit one name (or
blank it), the stored `amenity_label` is hedged as "winner / runner-up"
— the timeline then shows both candidates instead of a confident
coin-flip. A confident wrong label is worse than an honest hedge; it is
the actual bug being fixed. (Storing the full ranked candidate set as
structured data, for a richer UI than a hedged string, is deferred
until such a UI exists — `focus_places` is recomputed every refresh, so
the column costs nothing to add later.)

### 6. Split fused multi-venue clusters (Phase 4)

The stay-clustering radius merges venues tens of metres apart into one
cluster, so a single focus-place can host visits to several distinct
real places (a café and a clinic in one parade). No single label is
correct for such a cluster.

Detect and split: within a focus-place, sub-cluster the per-visit
weighted centroids at a tighter radius; if they separate into stable
sub-modes — especially when the sub-modes also differ in *visit
character* (dwell length, time-of-day, frequency) — emit them as
distinct places. A clinic visited twice for ~2 h is a different place
from a café visited ten times for ~1.5 h, even 50 m away.

This is the harder, lower-confidence half of Phase 4: GPS noise means
sub-modes overlap and will not always separate cleanly. Where a fused
cluster cannot be split, §5's honesty gate applies — name it by the
dominant candidate with the alternatives surfaced.

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
- **Phase 4 — multi-signal naming + cluster splitting.** Design §5 and
  §6. Replaces the nearest-node label with history-informed candidate
  scoring plus an honesty gate (an ambiguous result is stored as a
  hedged "winner / runner-up" label — no schema change). Splits fused
  multi-venue clusters where the data allows. The substantive naming
  fix — no manual entry. §5 (naming) ships before §6 (splitting).

## Residual limits

Even with Phases 1–4, naming a place stays probabilistic. Multi-signal
scoring (§5) is a best *guess*: where OSM's node is badly mis-placed, or
two candidates share type, pattern *and* name cues, the data simply does
not determine which the user means. Splitting (§6) cannot separate
sub-modes that overlap within GPS noise. The honesty gate makes these
cases surface as "likely X" with alternatives rather than a false
certainty — but a *guaranteed* name needs a signal from outside the
user's GPS/Fitbit data: a one-time user confirmation, or a name
arriving from another stream (e.g. a calendar event). Both are out of
scope here. The goal of this proposal is to make the unaided guess as
good — and as honest — as the data allows.
