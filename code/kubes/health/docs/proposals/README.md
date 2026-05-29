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
| `2026-05-scored-classification.md` | active | Replace today's rule-cascade classification with factor-decomposed scoring + commute-history prior; staged path with optional HMM escalation at the end |
| `2026-05-utc-three-tier.md` | active | Add `ts_utc` + `tz_source` columns to Fitbit intraday tables; three-tier `ts`/`ts_utc`/`tz_source` framing keeps the verbatim Fitbit response immutable while making `ts_utc` recomputable |
| `2026-05-weighted-place-accumulation.md` | paused | Focus-place centroid weighting + multi-signal naming. All phases implemented and **fully reverted** — kept as the investigation record (dwell unmineable from focus_places; accuracy-weighting not outlier-robust). See the proposal's Outcome |
| `2026-05-conflated-place-clusters.md` | active | Disambiguate co-located places (a café and a residence ~115 m apart, merged by the 150 m clustering radius) using time-of-day: an hour-of-day profile on `focus_places` splits the conflated cluster and routes stays at runtime; distance-aware landmark priority; opening-hours soft vote; confidence gate + manual labels. Builds on the paused proposal's §6 |
| `2026-05-physical-plausibility.md` | active | Reject mode classifications that violate basic physics (walking @ 60 km/h, train @ 0.5 km/h). Pre-dates the HSMM duration factors; some overlap |
| `2026-05-honest-gaps.md` | shipped | Emit `unknown` for unobserved time rather than synthesising plausible-looking placeholder states |
| `2026-05-joint-sequence-model.md` | active | Phase 1 HMM (state space + Viterbi + emission + transition). Anchor for the classification rewrite |
| `2026-05-hmm-learned-emissions.md` | active | Phase 2: per-mode + per-place HR/cadence/speed distributions fit from heuristic labels via supervised MLE |
| `2026-05-hsmm-physical-constraints.md` | active | Phase 3: Hidden Semi-Markov Model with explicit duration distributions and a soft-factor library for physical constraints (sleep coherence, geometric feasibility, HR continuity) |
| `2026-05-route-aware-decoder.md` | design | Phase 4: promote state from `mode` to `(mode, route, position)` on the OSM graph. Subsumes geometric feasibility, rail-corridor boost, station-graph, place-distance, off-network factors into one topological framework. ~7-9 weeks, staged: train-only → walking/driving → stationary → retire approximating factors. Direct response to the 2026-05-22 Met Line audit |

**Read `docs/design/probabilistic-principles.md` before adding new
factors, tuning parameters, or proposing alternatives.** That
document is the contract behind all of the Phase 1–3 proposals: it
explains the philosophy (probabilistic constraint solver, not
heuristic stack), the rules (no hard constraints; graduated
probabilities; offline precompute; do it right not MVP-shortcut),
and the current factor library.

Rail-snap shipped 2026-05-18 (station-anchored, offline-precomputed) — its proposal was retired into `docs/design/rail-snap.md`.
