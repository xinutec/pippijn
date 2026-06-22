# Pedestrian trajectory smoother — a physically-precise walk estimate

Status: accepted, in implementation (2026-06-22)
Relationship: the walking counterpart of
`2026-06-map-constrained-positioning.md`. That doc constrains *driving* to
the 1-D road network (a hard rail). Walking needs the opposite stance — a
*soft* surface prior — plus a signal driving doesn't have: the pedometer.

## The problem

A slow walk is the hardest leg to draw. At 4 km/h the per-fix GPS velocity is
buried in noise, so the road-blind Kalman is useless and the raw fixes zigzag.
Measured on the 2026-06-21 car→Dasha's→car walks: drawn path length 2–3× the
straight-line distance (tortuosity 2.7×), worst single jumps 25–46 m, driven by
a few fixes whose accuracy is 150–230 m sitting among decent ~12–19 m fixes.

Driving's fix — snap to the road — is *wrong* for walking, and the user was
explicit about why:

> in a forest I'm very free to walk anywhere. on streets I'm dynamic — sometimes
> precise (I walk on one side or another), sometimes not. We need to take all
> that into account and make a precise estimate of how I'm walking (if I'm
> walking, most likely).

So the map is **evidence weighted by how constraining the local environment is**,
never a rail: strong in a narrow alley, ~zero in open ground. And the estimate
must be **honest about its own uncertainty** — it must not fabricate which side
of a street you were on when nothing measured can resolve it.

## The insight: GPS is the *weakest* signal here

For a slow walk we have three signals stronger than GPS, all currently discarded:

1. **The pedometer.** Fitbit logs steps/minute. steps × stride = **distance
   travelled**, measured independently of GPS and far more precisely. This is the
   cornerstone of pedestrian dead-reckoning (PDR). It directly pins arc length —
   exactly what tortuosity gets wrong.
2. **Both endpoints are known almost exactly.** The walk starts where the car
   stopped (a confident cluster) and ends at a long dwell (a tight cluster /
   building). A short walk clamped at both ends has little freedom to wander.
3. **The map — softly.** Walkable surface (pavement, path, the route through a
   park) is a weak prior on where a body can be, its strength set by how
   constraining the surroundings are.

## The model — a MAP trajectory smoother (factor graph)

Represent the trajectory as a position per GPS-fix timestamp (resampled to ≤ a
few seconds where fixes are sparse), `p_0 … p_{n-1}` in a local metric frame.
Find the trajectory minimising the sum of physically-meaningful costs — the
*maximum-a-posteriori* path given everything measured:

| Factor | Cost | Encodes | Why it matters here |
|---|---|---|---|
| **Robust GPS** | `Σ ρ_huber(\|p_i − z_i\| / σ_i)` | each fix pulls with weight 1/accuracy², through a heavy-tailed loss | the 230 m fix contributes ≈0; it can't yank the line. Kills the spikes |
| **Step-distance (PDR)** | `Σ (\|p_i − p_{i−1}\| − d_i)²` | arc length over an interval ≈ steps×stride | pins total length → fixes tortuosity; bounds speed to a human gait |
| **Endpoint anchors** | `\|p_0 − A\|² + \|p_{n−1} − B\|²` | strong priors at the car stop and the dwell place | clamps both ends |
| **Smoothness** | `Σ \|p_{i−1} − 2p_i + p_{i+1}\|²` | bounded acceleration / turn rate | no physically-impossible zigzags |
| **Soft, env-modulated map** | `Σ w(env_i)·dist_to_walkable(p_i)²` | gentle pull onto walkable surface, *weighted by local openness* | nudges onto a pavement in a corridor; **≈0 in a park/forest** — the "free to walk anywhere" requirement |

The map weight `w(env)` is the whole answer to "free in a forest, dynamic on a
street": inside a pedestrian-area / park / open polygon it is ~0 (any point is
walkable, no pull); along a lone footway between buildings it is higher; and it is
always small relative to the GPS+PDR terms, so the map can *bias* but never
*override* where the evidence says you were. Side-of-street is left to the GPS —
where GPS can't resolve it, the estimate stays mid-corridor and reports the
ambiguity rather than guessing.

### Inference

Offline batch **MAP** estimate (we have the whole walk, so a *smoother* using
all fixes past+future — strictly better than the forward-only Kalman that caused
the original swing). Solve by gradient-based nonlinear least squares with
**IRLS** for the robust GPS term (re-weight by the Huber weight each iteration;
the rest is weighted least squares). Converges in tens of iterations for the
~20–60-point trajectories we see. The fully-advanced tail — discrete
which-footway association via a Rao-Blackwellised particle smoother — is deferred;
the soft continuous map penalty captures most of its value without the cost.

### Honest uncertainty

Each output vertex carries a posterior σ (from the local curvature / how much GPS
+ map pinned it). Where signals are weak (no steps, no GPS, open ground) the
estimate relaxes to the robust-smoothed line and **widens σ** rather than
inventing precision. The renderer can show this (e.g. a fainter / wider line) so
a low-confidence walk reads as low-confidence. Gated on the leg being **walking**
in the first place — the smoother only runs on walking episodes; a mis-moded leg
is a classification problem, not this layer's.

## Why this is "most advanced + physically precise"

It is the textbook robotics-SLAM / indoor-PDR fusion: the pedometer supplies
precise *relative* displacement, GPS supplies noisy *absolute* position with
honest per-fix covariance, the endpoints supply *boundary conditions*, the map
supplies *soft feasibility*, and gait dynamics supply *smoothness*. Each covers
the others' blind spot. The output is the most probable physical path given the
data — not a cosmetic smooth.

## Staged, measured plan

Same discipline as the road work: a number before every claim, display-only and
golden-safe at each step (states never change; only drawn geometry does).

- **Phase 0 — measurement.** Extend the position eval to walking legs; add a
  **step-distance-consistency** metric (reconstructed arc length vs pedometer
  distance) and a **tortuosity** metric. `src/eval/walk-score.ts` + tests +
  a `score-walk` CLI. No behaviour change.
- **Phase 1 — robust GPS smoother + anchors.** Pure `src/geo/pedestrian-smooth.ts`:
  heavy-tailed accuracy-weighted GPS + smoothness + endpoint anchors, MAP solve.
  Unit tests pin: outlier rejection, anchor clamping, a straight walk stays
  straight. Wire into the walking branch (display-only, `kind:"smoothed"`).
- **Phase 2 — fuse the pedometer (PDR).** Add the step-distance factor + a stride
  estimate (default ~0.72 m, later learned per-user from GPS-confident walks).
  Metric: tortuosity → ~1 and arc length → pedometer distance.
- **Phase 3 — soft env-modulated map.** Add `walkableRoads` to the OSM loader/
  adapter (footway/path/pedestrian/steps/…, record-replay like `drivableRoads`)
  + pedestrian-area/park polygons for the openness weight `w(env)`. Add the soft
  map factor. Metric: on-walkable improves *without* the line over-committing in
  open areas (openness test).
- **Phase 4 — uncertainty + solver hardening.** Per-vertex posterior σ surfaced to
  the renderer; convergence/​robustness tests; (optional, deferred) particle
  smoother for which-footway association.

## Relationship to other work

- `2026-06-map-constrained-positioning.md` — sibling; drives = hard road rail,
  walks = soft surface + PDR. Shares the position-eval foundation.
- `#265` map-constrained positioning (driving) — this is its pedestrian arm.
- `#176` walk/vehicle handoff — ensures a leg is *actually* walking before this
  layer runs.
- HMM-debt — this is a *display/geometry* layer, not classification; it does not
  touch states or golden.
