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
| `2026-05-rail-snap.md` | active | Draw train journeys on the rail track instead of a raw GPS zigzag. First attempt (per-fix map-matching) shipped and **fully reverted** — fixes can't drive geometry. Redesign: station-anchored (line + boarding/alighting stations + time). Includes the real-data fixture testing strategy |
