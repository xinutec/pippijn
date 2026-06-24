# Proposals

Active design proposals for health-sync. Each is a substantial change
to architecture or pipeline that's worth thinking through before
writing code.

When a proposal lands in code (becomes "shipped" rather than
"proposed"): either summarise the relevant outcomes into
`docs/design/` and delete the proposal, or move the proposal to
`archive/` and link to the design doc that describes the shipped
result. Pick one — don't leave a "this happened" proposal cluttering
this directory.

When a proposal is superseded or paused: move it to `archive/` with
the `status` frontmatter updated.

## Active

| File | Status | Topic |
|---|---|---|
| `2026-06-journey-worldline.md` | proposed | The **integration target** for the decoder line of work: make the latent object one continuous map-matched worldline — a connected path through a *unified multimodal* graph — so physical feasibility (no teleports; board = previous alight; lines connect their endpoints) is a property of the hypothesis space, not a post-hoc pass. Impossible journeys become unrepresentable. Subsumes constraint-first + joint-sequence + map-constrained-positioning + decoder-owns-mode |
| `2026-06-decoder-owns-mode.md` | design | Make the joint probabilistic decoder — not the heuristic refinement stack — own MODE in the timeline, retiring the cascade's mode passes. The mode arm of the journey-worldline target (#257) |
| `2026-05-constraint-first-decoder.md` | design | Generator/scorer split: hard physical constraints (train (board, line, alight) triples; walking speed bounds; cross-segment continuity; sleep-window coherence) filter the candidate space, then the HSMM scores the survivors. Architectural anchor for the per-minute decode |
| `2026-06-phase1-train-softprior.md` | design | Phase 1 of decoder-owns-mode: wire the train generator as a soft per-segment prior (revised after adversarial review — soft, not a hard candidate filter that drops real rides) |
| `2026-06-tube-journey-segment.md` | design | Post-decode wrapper grouping consecutive train + intra-station-walk + platform-wait minutes into a single tube-journey segment. Per-minute decoder unchanged; UI + eval move to journey-level granularity |
| `2026-06-truth-engine.md` | design | The **measurement foundation**: a multi-sensor, physically-grounded, honest day decoder + the eval apparatus (journey-level scorer, bus-scorable mode, confidence calibration) that every other phase's "no-regression" gate rests on. A bespoke decoder for one life (#250) |
| `2026-06-map-constrained-positioning.md` | proposed | Replace the road-blind Kalman front-end with a map-constrained Bayesian smoother: estimate position *on the map* (roads/rails/pavements/place polygons) under a robust noise model + learned personal route prior, instead of filtering in free space then cosmetically snapping. Promotes `road-match`/`rail-snap` from display layer to the estimator |
| `2026-06-magnetic-focus-places.md` | design | Place attribution as a stateful pull from focus_places, not a per-segment pick. Strong recurring places anchor noisy-GPS attribution against geometrically-close generic OSM POIs. Soft prior, range-gated, detached by movement evidence |
| `2026-06-presence-continuity.md` | design | Temporal extension of the magnet: established stays persist across sparse-data days. A `presence_log` seeds the next day's decoder with the prior day's end-state; confidence decays so multi-day no-data renders as `presumed`, not `confident`. Targets the Cleveland Clinic 8-day stay |
| `2026-05-scored-classification.md` | active | Replace today's rule-cascade with factor-decomposed scoring + commute-history prior. Most phases shipped; the factor scorer is the per-minute scoring layer in the constraint-first architecture |
| `2026-05-hmm-learned-emissions.md` | partly shipped | Per-mode emission distributions fit from heuristic labels; supervised-learning pipeline lives at #208 |
| `2026-05-physical-plausibility.md` | vision | Quality bar — what "physically plausible + logically sensible" means as an output property. The constraint-first decoder is the architecture that meets it |
| `2026-06-deterministic-fixtures.md` | design (revised) | Deterministic, zero-DB fixtures for the classification pipeline via an adapter pattern over unbounded sources (OSM, Fitbit, PhoneTrack); the `npm run golden` replay harness |
| `2026-06-google-health-migration.md` | deferred | Fitbit Web API → Google Health API migration ahead of the Sep 2026 sunset (#260). Unrelated to the decoder line of work |

## Archived (`archive/`)

Settled work — shipped, superseded, paused, or parked. Kept for the record; not active design.

| File | Status | Topic |
|---|---|---|
| `archive/2026-06-pedestrian-trajectory-smoother.md` | shipped | The walking arm of map-constrained positioning — a MAP factor-graph smoother (robust GPS + pedometer + endpoint anchors + soft walkable-surface prior), display-only. Measured 2026-06-21: step-error 110%→5% |
| `archive/2026-05-conflated-place-clusters.md` | shipped | Disambiguate co-located places using time-of-day profiles; distance-aware landmark priority; confidence gate |
| `archive/2026-05-honest-gaps.md` | shipped | Emit `unknown` for unobserved time + trajectory-segmented `findStays` |
| `archive/2026-05-hsmm-physical-constraints.md` | shipped | HSMM Viterbi + per-state duration distributions + sleep-coherence + HR continuity. Reused as the constraint-first decoder's scorer |
| `archive/2026-05-joint-sequence-model.md` | shipped (Phases 0a-1.7) | MVP HMM bridge from factor scorer to per-day decoder. Architectural successor: `2026-05-constraint-first-decoder.md` |
| `archive/2026-05-utc-three-tier.md` | shipped | Three-tier `ts`/`ts_utc`/`tz_source` schema for Fitbit intraday |
| `archive/2026-05-weighted-place-accumulation.md` | paused (reverted) | Focus-place centroid weighting + multi-signal naming. All phases implemented and **fully reverted** — kept as the investigation record |
| `archive/2026-05-route-aware-decoder.md` | superseded | Promoted state from `mode` to `(mode, route, position)` via inner edge-Viterbi; Phase 1 proper regressed mode 0.6 pp. Superseded by `2026-05-constraint-first-decoder.md` |
| `archive/2026-06-tunnel-transit-coherence.md` | on-hold — do not implement as written | Stop the decoder fragmenting GPS-dark underground rides. STATUS (2026-06-13): premise undercut by adversarial review; pending re-measure on re-captured fixtures |

**Read `docs/design/probabilistic-principles.md` before adding new
factors, tuning parameters, or proposing alternatives.** That
document is the contract behind all of the proposals: it explains
the philosophy (probabilistic constraint solver, not heuristic
stack), the rules (no hard constraints in *scoring*; graduated
probabilities; offline precompute; do it right not MVP-shortcut),
and the current factor library.

The 2026-05-31 update: hard constraints belong in the *generator*
(filter the candidate space upstream), not in the scorer
(per-minute soft penalties downstream). See
`2026-05-constraint-first-decoder.md`.

Rail-snap shipped 2026-05-18 (station-anchored, offline-precomputed) — its proposal was retired into `docs/design/rail-snap.md`.
