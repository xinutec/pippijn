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

## Index

| File | Status | Topic |
|---|---|---|
| `2026-06-map-constrained-positioning.md` | proposed | Replace the road-blind Kalman front-end with a map-constrained Bayesian smoother: estimate position *on the map* (roads/rails/pavements/place polygons) under a robust noise model + learned personal route prior, instead of filtering in free space then cosmetically snapping. Promotes `road-match`/`rail-snap` from display layer to the estimator; subsumes the #261 confidence gate. Motivated by the ±80 m fix the Kalman moved 80 m off-road (health vs NC, 2026-06-21) |
| `2026-05-constraint-first-decoder.md` | **design (current architecture)** | Generator/scorer split: hard physical constraints (train (board, line, alight) triples; walking speed bounds; cross-segment continuity; sleep-window coherence) filter the candidate space, then the existing HSMM scores the survivors. Architectural anchor for the per-minute decode; pairs with the tube-journey wrapper below for segment-level composition |
| `2026-06-tube-journey-segment.md` | **design (composition layer)** | Post-decode wrapper that groups consecutive train + intra-station-walk + platform-wait minutes into a single tube-journey segment. Per-minute decoder unchanged; the wrapper resolves the labelling-convention friction (decoder honest about cadence-confirmed walking inside stations vs GT absorbing those minutes into trains). UI + eval move to journey-level granularity |
| `2026-05-physical-plausibility.md` | vision | Quality bar — what "physically plausible + logically sensible" means as an output property. The constraint-first decoder is the architecture that meets it |
| `2026-05-scored-classification.md` | active (factor-scorer Phase 1) | Replace today's rule-cascade with factor-decomposed scoring + commute-history prior. Most phases shipped; the factor scorer is the per-minute scoring layer in the constraint-first architecture |
| `2026-05-utc-three-tier.md` | shipped | Three-tier `ts`/`ts_utc`/`tz_source` schema for Fitbit intraday |
| `2026-05-weighted-place-accumulation.md` | paused | Focus-place centroid weighting + multi-signal naming. All phases implemented and **fully reverted** — kept as the investigation record (dwell unmineable from focus_places; accuracy-weighting not outlier-robust) |
| `2026-05-conflated-place-clusters.md` | shipped | Disambiguate co-located places using time-of-day profiles; distance-aware landmark priority; confidence gate |
| `2026-06-magnetic-focus-places.md` | design | Place attribution as a stateful pull from focus_places, not a per-segment pick. Strong recurring places anchor noisy-GPS attribution against geometrically-close generic OSM POIs (e.g., Varley vs Canada Gardens). Soft prior, range-gated, detached by movement evidence |
| `2026-06-presence-continuity.md` | design | Temporal extension of the magnet: established stays persist across sparse-data days. A `presence_log` table seeds the next day's decoder with the prior day's end-state; continuation segments fill gaps when no contradicting evidence appears. Confidence decays over time so multi-day no-data periods render as `presumed`, not `confident`. Targets the Cleveland Clinic 8-day stay case |
| `2026-05-honest-gaps.md` | shipped | Emit `unknown` for unobserved time + trajectory-segmented `findStays` |
| `2026-05-hmm-learned-emissions.md` | partly shipped | Per-mode emission distributions fit from heuristic labels; supervised-learning pipeline lives at #208 |
| `2026-05-hsmm-physical-constraints.md` | shipped | HSMM Viterbi + per-state duration distributions + sleep-coherence + HR continuity. The constraint-first decoder reuses this as its scorer |
| `2026-05-joint-sequence-model.md` | shipped (Phases 0a-1.7) | MVP HMM bridge from factor scorer to per-day decoder. Architectural successor is `2026-05-constraint-first-decoder.md` |
| `2026-05-route-aware-decoder.md` | superseded | Promoted state from `mode` to `(mode, route, position)` via inner edge-Viterbi. Phases 0, 1A, 1A++, 1B, and Phase 1 proper all shipped; Phase 1 proper regressed mode by 0.6 pp on the eval. Successor: `2026-05-constraint-first-decoder.md` |

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
