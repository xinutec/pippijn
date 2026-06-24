---
created: 2026-05-24
updated: 2026-05-31
status: shipped (Phases 0a-1.7); architectural successor decoder-roadmap.md
references:
  - ../archive/2025-model-hmm.md
  - decoder-roadmap.md
  - 2026-05-scored-classification.md
  - decoder-roadmap.md
---

# Joint sequence model — bridging the factor scorer to a per-day decoder

> **Outcome (2026-05-31)**. Phases 0a (stable focus_place IDs),
> 0b (`line_stations`), 0c (observation tensor + `decoded_days`),
> and 1 (MVP HSMM with Viterbi, state-space, transition matrix,
> emission model, entry priors) all shipped. The decoder is
> running in prod via `applyHsmmPlaceOverride`. The 5-day
> blessed eval (2026-05-31) gives mode 95.3%, place 97.8%, line
> 0/6 — the joint-sequence approach reached the per-minute
> factor library's structural ceiling. The architectural
> successor that addresses the line-score ceiling is
> [`decoder-roadmap.md`](./decoder-roadmap.md),
> which replaces the per-minute filtering approach with a
> generator/scorer split. The HSMM Viterbi shell built here is
> reused by the constraint-first decoder as the scorer over the
> generator's candidate set.

## Why this proposal now

The pipeline has 14 sequential local-decision passes. Each pass sees
its own neighbourhood, picks the best local answer, hands off. Recent
work (honest gaps, trajectory-segmented findStays, biometric-aware
stay-split, factor scorer for refineMode) has tightened each pass —
but the 22 May residuals are showing that a class of bugs cannot be
fixed by tightening any individual pass:

- **Tube under road labelled "driving on Euston Underpass"**.
  `refineMode` sees a single segment with coarse fixes near both a
  rail line (50 m above) and a road (10 m above). The local OSM
  evidence is genuinely ambiguous. The disambiguating signal — "the
  next segment is unambiguously a Met Line tube ride continuing —
  exists in the surrounding context but is invisible to a
  single-segment decision.

- **Same Met Line ride split into "driving" + "train"** at King's
  Cross → Finchley Road. The first portion is labelled "driving on
  Euston Underpass" (the tube tunnel parallels the road); the
  second portion correctly recognised as Met Line train. Should be
  one continuous Met Line ride. `annotateRailRuns` segments at
  the boundary because the local mode-decision for the first
  portion was wrong.

- **20-minute pause near a tube exit labelled "Loft Coffee Company"
  / "Waterstones"**. `pickBestPlace` commits to the nearest POI
  because it scores per-segment. Without knowing "this stay sits
  between two walking segments, total trip is hospital → home, no
  café outing intended", it has no basis to hedge.

- **Slow stop-start taxi labelled "walking" / "stationary"**.
  Per-segment mode classification has no way to know "this slow
  zigzag is traffic, not pedestrian motion" without modelling the
  whole journey.

All four are local-evidence wrong-choices that **only get the right
answer if the whole day-shape is scored**. Adding more local passes
(same-line coalescer, brief-stay POI guard, slow-taxi factor) would
catch each specific case individually but compound the pass-stack and
inevitably miss the next bug-class. The architecture is at its
ceiling for this kind of issue.

The principled fix is a joint sequence decoder — score whole
day-shapes, pick the highest-scoring sequence. The design is in
`../archive/2025-model-hmm.md` (1058 lines, comprehensive). This
proposal does not redo that design. It audits what is already in
place, identifies what is missing, and articulates a minimum viable
decoder that closes the 22 May residuals without committing to the
full HMM spec up front.

## Foundations audit — what already exists

The 2025 HMM design was paused because building it from scratch was
~8-9 weeks of speculative work. Since then we have built — under
the `2026-05-scored-classification.md` roadmap — pieces that fit
naturally into the HMM's emission and structural layers. Audit
result:

### Already built and HMM-compatible

| Component | Status | HMM role |
|---|---|---|
| Factor scorer (`src/geo/factors/`) | Built behind `USE_FACTOR_SCORER` flag (currently off in prod — #193 to re-enable properly) | Becomes the per-state emission model. `speed-emission`, `osm-distance`, `mode-coherence`, `biometric-ll`, `rail-corridor` are emission components. |
| Candidate generator (`refine-mode-candidates.ts`) | Built. Enumerates plausible `(mode, way)` tuples per segment, with biometric filters. | Generates the state-space neighbourhood at each minute. The HMM's "reachable states from current state" comes from this. |
| `mode_biometrics` per-user signatures | Mined nightly. | Per-user emission parameters (HR/cadence distributions per mode). |
| `focus_places` clustering | Built; needs stable IDs (#80). | The `place` dimension of HMM state. |
| Rail-route geometry cache (`rail_route_cache`) | Built. Offline-computed snapped train paths per (line, station-pair). | The `line` dimension's geometry. |
| Trajectory-segmented `findStays` | Just shipped. | Generates `stationary @ place` state candidates. |
| Biometric-aware stay-split (`stay-split.ts`) | Just shipped. | Detects mid-stay departures using HR + steps. Becomes a forward-backward smoothing constraint. |
| `unknown` mode + segment-level honest gaps | Just shipped. | The "no observation" state-set in the HMM (Bernoulli `p(gps=null|s)`). |
| Sleep window detection + place attribution | Built (`src/sleep/`). | The `sleeping @ home` and `sleeping @ hotel` state values, plus the morning/evening edge handling that the HMM naturally subsumes. |
| Capture-day CLI + real-data fixtures | Built; 5+ fixture days captured. | Fixture-day supervision for EM init (Phase 0c in the 2025 doc). |

### Missing infrastructure

| Component | Status | Effort |
|---|---|---|
| Station-graph data (`line_stations` table + ingest) | Not built. 2025 doc spec'd as new infra. | ~3 days (Overpass query + table + cache + seed script) |
| Stable `focus_places.id` across rebuilds (#80) | Tracked, not started. | 1-2 weeks per 2025 doc estimate (centroid-overlap identity matching with split/merge). |
| Per-day decode persistence (`decoded_days` table) | Not built. | ~2 days |
| Per-minute observation tensor builder | Not built. (Today's pipeline operates on 5-minute windows; HMM wants 1-minute observations.) | ~3 days |
| Viterbi decoder | Not built. | ~5 days (pure function + tests) |
| Forward-backward + EM training loop | Not built. | ~7 days |
| Per-state observation counter (for fallback gating) | Not built. | ~2 days |
| Cold-start heuristic-fallback wiring | Not built. | ~2 days |

### Carry-forward from 2026-05-scored-classification.md

Three items from the scored-classification roadmap that the HMM
subsumes — work that was planned for Phase 2 / Phase 3 of that
roadmap and that this proposal absorbs:

- **`journey_patterns` commute prior**: subsumed by the HMM
  transition matrix conditioned on `(hour, day_of_week)`.
- **`?explain=1` factor-breakdown endpoint**: still useful, but
  the response becomes "posterior probability + Viterbi path"
  rather than "factor sum + alternatives". Frontend rendering
  changes; endpoint stays.
- **Mining lifecycle + `classifier_version`**: still needed (HMM
  retraining triggers re-decode), but the bookkeeping is simpler
  because the HMM is one model not a stack of factors.

## 22 May residuals → HMM mechanisms

Concrete mapping of each remaining 22 May issue to the HMM mechanism
that fixes it. This is the "what does the architecture buy us"
audit:

### Tube under road labelled "driving on Euston Underpass"

**Mechanism**: transition self-loop probability inside `train` state
is high enough (~0.95) that Viterbi prefers the continuous-train
interpretation. At the noisy minute, both `train` and `driving` have
non-trivial emission probability (the fix is near both a rail line
and a road). The Viterbi argmax weighs the emission prob × transition
prob to the previous minute's state. Previous minute was
unambiguously `train` (well within the Met Line tunnel, OSM rail
geometry exactly matches). Transition `train → train` has prob
~0.95; `train → driving` has prob ~0.0001 (rarely observed in
training). Even if the noisy-minute emission slightly favours
`driving` (e.g. 0.4 vs 0.3), the transition prior pulls the path
back to `train`.

This is the "Station B" mechanism from the 2025 doc. Same principle.

### Same Met Line ride split into "driving" + "train" at King's Cross

**Mechanism**: same as above. The MAP path picks `train` for both
sides because the transition prior dominates. The split disappears
because there's no minute where both `train_left_of_kx` and
`train_right_of_kx` are different states — they're both
`(train, Metropolitan_Line, none)`. Segment collapse groups
consecutive same-state minutes into one segment.

### "Loft Coffee Company" / "Waterstones" labelling for 20-min stay

**Mechanism**: the stay is bracketed by walking segments. In the
HMM, the bracketing minutes are `walking` state. The 20-min stay
becomes a contiguous run of `stationary @ none` (no focus place
matches, no overnight). The post-decode `bestPlace` label pass then
runs on the stay's centroid — but with the stay's *duration* now
available as a feature. A 20-min stay near 5 candidate POIs scores
each candidate by `p(20-min stay | POI type)`. Coffee shops have a
distribution peaked at ~30-90 min (the user spent 20 min); a tube-
exit transit pause has a peak at ~2-5 min. The pause is more
consistent with "tube exit area" than "coffee shop". Output:
"stationary near Finchley Road (low confidence)" rather than
fabricated venue.

This requires extending `bestPlace` with the duration-aware POI
prior. Bounded change, parallel to the HMM.

### Slow taxi labelled "walking" / "stationary"

**Mechanism**: HR + cadence emission. A 15-min slow vehicle ride
shows: HR slightly elevated (sitting still in moving vehicle, low
~70-80 bpm), zero cadence (no steps), low GPS speed (5-15 km/h in
traffic). The per-state emissions:
- `walking`: cadence ~80-120 spm, low GPS speed → cadence emission
  is ~0 (no steps observed) → driven to near-zero likelihood.
- `stationary`: GPS speed should be ~0 → 5-15 km/h GPS speed →
  driven down by speed emission.
- `driving`: HR moderate, cadence ~0, GPS speed in driving range →
  highest joint likelihood.

Today this fails because `walking` is picked by a speed-only
classifier; the cadence + HR signals are applied as a post-pass
that can only override on strong evidence. Joint emission catches it
at the first decode.

### Common thread

All four cases are won by the SAME mechanism: joint per-minute
emission combined with state transitions. None of them need
mechanism beyond what's already in the 2025 design. The current
factor-scorer pieces (emissions) plus a Viterbi pass over a small
state space is enough.

## Minimum viable HMM (MVP)

The 2025 doc spec'd the full system — 50-90 states, EM training over
180 days, per-user mixture emissions, 6-10 week budget. That's still
the right end state. But we don't need to build all of it before
seeing benefit on the 22 May class. The MVP is:

### State space (small)

Per-user reachable states only. Bootstrap from current heuristic
output:

- `stationary @ {top-10 focus_places, none}` → ~11 states
- `walking @ none`, `cycling @ none`, `driving @ none`,
  `plane @ none` → 4 states
- `train @ {top-5 user-relevant lines, unknown_rail}` → 6 states

Total: ~21 states for a typical single-user model. 2025 doc said
50-90 for a fully mined model; 21 is enough to demonstrate the
joint-decode benefit on familiar daily journeys.

### Emissions (reuse factor scorer)

Per-state emission `p(O_t | s)` is a product of:

- `p_gps_present(present | s)` — Bernoulli, learned from
  observation density per state.
- `p_speed(speed | s)` — single Gaussian per state (mixture
  later). For Phase 1 a single Gaussian's variance covers most
  cases.
- `p_osm_distance(d_line, d_road | s)` — exponential per state.
  For `train` states, `d_line` distribution is tight (typical
  ~10-30 m); for `driving`, `d_road` is tight.
- `p_hr(hr | s)` — single Gaussian per state.
- `p_cadence(cadence | s)` — zero-inflated single Gaussian.

The factor scorer already computes the log-likelihood pieces; the
HMM emission layer is mostly wiring those into a per-state product.

### Transition matrix (smooth + hard-zero)

- Learn from heuristic-pipeline bootstrap labels with Dirichlet
  smoothing `α = 0.1`.
- Hard-zero: `mode = stationary @ A → stationary @ B` (different
  place) is impossible; insert a moving state.
- Hard-zero: `train @ line_L → stationary @ place_P` is impossible
  when `P` is not near any station served by `L`. Requires the
  station-graph data (must be built; ~3 days).
- Self-transition probabilities are typically 0.95 for moving
  states, 0.99 for stationary states.

### Viterbi (per request)

Per-day Viterbi decode on 1-minute observation windows. ~1440
minutes × 21 states² = ~640k state-pair operations × ~5 per-minute
emission evaluations. Sub-50ms in TS.

### Per-day persistence

`decoded_days` table caches the MAP sequence per (user, date,
model_version). Re-decode only on model retrain. Same shape as
2025 doc.

### What MVP defers from the full 2025 doc

- Mixture emissions (single Gaussian for now).
- Per-state observation-count fallback (for MVP, all-state cold-
  start uses heuristic; once enough data exists, use HMM for
  everything).
- `time-of-day` context conditioning on transitions (use base
  transitions only).
- Heuristic-fallback smoothing between HMM and heuristic minutes
  (since MVP is all-or-nothing per user, no seam).
- Most of the schema versioning machinery (single emission schema
  for MVP; bump if it changes).

The 2025 doc has all of these as full-design extensions. The MVP
ships without them; full design lands as Phase 2.

## Phasing

Honest budget — the prerequisites are real, and the MVP itself is
~3 weeks of focused work on top of those.

| Phase | Work | Estimate | Output |
|---|---|---|---|
| 0a | `focus_places.id` stability (#80) — the 2025 doc's Phase 0a. Centroid-overlap identity matching, handles cluster split/merge. | 1-2 weeks | Stable place IDs survive nightly mining. |
| 0b | Station-graph data (`line_stations` table + Overpass route-relation ingest + seed script for user-observed lines). | ~3 days | `line_stations` populated for user's known lines (Met, Jubilee, Victoria, …). |
| 0c | Per-minute observation tensor builder + per-day persistence schema. | ~5 days | `buildObservationTensor(date, user)` + `decoded_days` table. |
| 1  | MVP HMM: state-space builder from bootstrap labels + emission wiring from factor scorer + transition matrix with hard-zero rules + Viterbi decoder. Behind `USE_HMM_DECODER` flag. | ~10 days | `USE_HMM_DECODER=1` on a sample user produces classifications. |
| 1.5 | Audit: HMM vs heuristic disagreement on 30 historical days. Hand-review every disagreement. Bug list of cases where HMM is worse. | ~3 days | Audit report + bug backlog. |
| 2 | Address audit bugs + enable HMM in prod for `pippijn`. | ~5 days | HMM-decoded segments are what the dashboard shows. |
| 3 | Brief-stay POI duration-aware label pass (parallel to HMM; closes the "Loft Coffee Company" class). | ~2 days | Bounded change to `bestPlace`. |
| Total | | **~5-7 weeks** | Joint decoder in prod, 22 May residuals resolved. |

Full design (Phase 2-4 of 2025 doc — mixture emissions, time-of-day
context, full schema versioning, audit tooling) lands incrementally
after MVP ships and is the natural follow-up.

## What this does NOT promise

- **Not magic.** The HMM is bounded by training data. Sparse-fix
  days (04-29, 04-30) still have ambiguity the HMM can't resolve
  without observations — but the honest-gaps work already handles
  those by surfacing `unknown` correctly. The HMM addresses
  *dense-day local-wrong-choice* bugs, not sparse-day no-data
  bugs.
- **Not a from-scratch rewrite.** Reuses factor scorer emissions,
  candidate generator, `focus_places`, rail-route cache, sleep
  detection, biometric ingestion, OSM mirror, Kalman filter. Most
  of the existing pipeline survives — the HMM replaces specific
  passes (`refineMode`, `applyBiometricSignature`, `mergeWindows`,
  `annotateRailRuns`, `inferTransitGaps`) with a single decode.
- **Not a deferral of all current work.** Brief-stay POI
  duration-aware labelling (Phase 3) is bounded and parallel —
  could ship in a day. Same-line train coalesce as a *local* patch
  is no longer worth it (HMM subsumes), but the underlying
  station-graph data (Phase 0b) is reusable for both approaches.

## Decision

Recommend committing to this proposal. The 22 May residuals are the
visible tip of a structural ceiling on the current architecture, and
piecemeal patches have started to compound rather than compose.
Building the MVP HMM is bounded (5-7 weeks), reuses the existing
foundations (factor scorer + honest gaps + trajectory clustering +
…), and closes the class of bugs that no future local patch can
reach.

The first concrete step is Phase 0a — `focus_places.id` stability
(#80). The 2025 doc called it the hard precondition; nothing has
changed. Start there.

## Decision log placeholder

- 2026-05-24 — proposal drafted, status `design`. Awaiting Pippijn
  review.
- _next_ — review outcome, scope adjustments, decision to commit
  or further iterate.
