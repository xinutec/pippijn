# Proposals

Active design proposals for health-sync. Each is a substantial change
to architecture or pipeline that's worth thinking through before
writing code.

When a proposal lands in code (becomes "shipped" rather than
"proposed"), is superseded, or is paused: update its `status`
frontmatter and move its row from the **Active** table to the
**Settled** table below. The file stays in `proposals/` — these docs
are densely cross-referenced (active proposals cite the shipped
foundations and the superseded experiments by path), so a separate
`archive/` directory only breaks links. Categorise in the README, not
the filesystem.

If a shipped proposal's outcome is better captured as a `docs/design/`
doc, summarise it there and delete the proposal — but only when it has
no inbound references left.

## Active

| File | Status | Topic |
|---|---|---|
| `decoder-roadmap.md` | active | **The single forward plan for the decoder line of work** (replaces 7 split proposals). Move the day's reconstruction into one joint probabilistic decoder that owns a continuous map-matched worldline — physical feasibility is a property of the hypothesis space, not a post-hoc pass. Covers the quality bar, the generator/scorer architecture, the measurement prerequisite (#250), and Phases 0–5 (#257) |
| `2026-06-map-constrained-positioning.md` | proposed | Replace the road-blind Kalman front-end with a map-constrained Bayesian smoother: estimate position *on the map* (roads/rails/pavements/place polygons) under a robust noise model + learned personal route prior, instead of filtering in free space then cosmetically snapping. Promotes `road-match`/`rail-snap` from display layer to the estimator |
| `2026-06-magnetic-focus-places.md` | design | Place attribution as a stateful pull from focus_places, not a per-segment pick. Strong recurring places anchor noisy-GPS attribution against geometrically-close generic OSM POIs. Soft prior, range-gated, detached by movement evidence |
| `2026-06-presence-continuity.md` | design | Temporal extension of the magnet: established stays persist across sparse-data days. A `presence_log` seeds the next day's decoder with the prior day's end-state; confidence decays so multi-day no-data renders as `presumed`, not `confident`. Targets the Cleveland Clinic 8-day stay |
| `2026-05-scored-classification.md` | active | Replace today's rule-cascade with factor-decomposed scoring + commute-history prior. Most phases shipped; the factor scorer is the per-minute scoring layer in the constraint-first architecture |
| `2026-05-hmm-learned-emissions.md` | partly shipped | Per-mode emission distributions fit from heuristic labels; supervised-learning pipeline lives at #208 |
| `2026-06-deterministic-fixtures.md` | design (revised) | Deterministic, zero-DB fixtures for the classification pipeline via an adapter pattern over unbounded sources (OSM, Fitbit, PhoneTrack); the `npm run golden` replay harness |
| `2026-06-google-health-migration.md` | deferred | Fitbit Web API → Google Health API migration ahead of the Sep 2026 sunset (#260). Unrelated to the decoder line of work |

## Settled

Shipped, superseded, paused, or parked. Kept in place for the record
(and still cited by the active proposals above); not active design.

| File | Status | Topic |
|---|---|---|
| `2026-06-pedestrian-trajectory-smoother.md` | shipped | The walking arm of map-constrained positioning — a MAP factor-graph smoother (robust GPS + pedometer + endpoint anchors + soft walkable-surface prior), display-only. Measured 2026-06-21: step-error 110%→5% |
| `2026-05-conflated-place-clusters.md` | shipped | Disambiguate co-located places using time-of-day profiles; distance-aware landmark priority; confidence gate |
| `2026-05-honest-gaps.md` | shipped | Emit `unknown` for unobserved time + trajectory-segmented `findStays` |
| `2026-05-hsmm-physical-constraints.md` | shipped | HSMM Viterbi + per-state duration distributions + sleep-coherence + HR continuity. Reused as the constraint-first decoder's scorer |
| `2026-05-joint-sequence-model.md` | shipped (Phases 0a-1.7) | MVP HMM bridge from factor scorer to per-day decoder. Architectural successor: `decoder-roadmap.md` |
| `2026-05-utc-three-tier.md` | shipped | Three-tier `ts`/`ts_utc`/`tz_source` schema for Fitbit intraday |
| `2026-05-weighted-place-accumulation.md` | paused (reverted) | Focus-place centroid weighting + multi-signal naming. All phases implemented and **fully reverted** — kept as the investigation record |
| `2026-05-route-aware-decoder.md` | superseded | Promoted state from `mode` to `(mode, route, position)` via inner edge-Viterbi; Phase 1 proper regressed mode 0.6 pp. Superseded by `decoder-roadmap.md` |
| `2026-06-tunnel-transit-coherence.md` | on-hold — do not implement as written | Stop the decoder fragmenting GPS-dark underground rides. STATUS (2026-06-13): premise undercut by adversarial review; pending re-measure on re-captured fixtures |

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
`decoder-roadmap.md`.

Rail-snap shipped 2026-05-18 (station-anchored, offline-precomputed) — its proposal was retired into `docs/design/rail-snap.md`.
