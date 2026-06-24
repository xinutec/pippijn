---
created: 2026-06-22
updated: 2026-06-24
status: proposed
references:
  - ../design/probabilistic-principles.md
  - 2026-05-joint-sequence-model.md
  - 2026-05-constraint-first-decoder.md
  - 2026-05-route-aware-decoder.md
  - 2026-05-physical-plausibility.md
  - 2026-06-map-constrained-positioning.md
  - 2026-06-decoder-owns-mode.md
  - 2026-06-tube-journey-segment.md
  - 2026-06-truth-engine.md
---

# Journey worldline — infer one continuous path, don't assemble-then-check fragments

> One-line: make the latent object **one continuous map-matched worldline** — a
> connected path through a unified multimodal transport graph, observed noisily —
> so physical feasibility (no teleports, board = previous alight, lines connect
> their endpoints) is a **property of the hypothesis space**, not a post-hoc pass.
> Impossible journeys become *unrepresentable* rather than *pruned*.

## Why now

The pipeline can emit a physically impossible day. Observed 2026-06-22: a single
Metropolitan-line ride was output as **two** train legs that **both alight at the
same station** — i.e. "arrive at X, then ride from an intermediate station back to
X." A worldline cannot do that.

The mechanism is instructive precisely because the guardrail meant to stop it
*exists and ran*:

- `enrichSegment`'s rail annotation (`src/geo/passes/rail-runs.ts`) correctly
  produced the real ride as one well-observed train leg (max 88.8 km/h → "too
  fast for a road", station-pair upgrade, confidence 1.0).
- `reconstructUndergroundRun` (`src/geo/underground-rail.ts:114`) then took a
  handful of trailing coarse fixes — the tail of the *same* arrival, where GPS was
  patchy — and **fabricated a second train leg**, resolving its endpoints fresh
  from the line graph without reference to the leg before it.
- `reconcileAdjacentRailLegs` (`src/geo/passes/rail-reconcile.ts:109`) — the
  "back-to-back train legs must share a station" rule (#175) — *did* run
  afterward, but it enforces continuity by **parsing `wayName` strings**
  (`"Board → Alight · Line"`, `parseRailWayName` at `rail-reconcile.ts:78`) and
  rewriting one endpoint. A string-matching post-hoc pass over an output a *later*
  stage may still mutate is brittle: the impossibility survived it.

This is the whole anti-pattern in one bug. We **generate a trajectory, then check
it** with a stack of ~38 ordered passes (`computeVelocityFromInputs`,
`velocity.ts:504`), each making a *local* decision and handing off. No stage owns
the question "is the whole day one realizable path?" So an impossibility that
spans two legs lives in the *gap between* stages, where no single check looks —
and we patch it reactively (#175, #176, #181, #234 are each one impossibility
someone noticed). Coverage is therefore a patchwork: we forbid the failure modes
we have seen, and the next stage-interaction produces the next one.

### A second instance: place continuity, not just rail (2026-06-24)

The same disease, on the *place* axis rather than the *journey* axis — proof
the worldline principle has to cover stays and sleep, not only train legs.
Output for 2026-06-24:

```
23:24–07:17  sleeping  @ University College Hospital   (central London, 51.52,-0.13)
08:48–09:03  walking   on Barn Rise                    (Wembley,        51.57,-0.28)
```

Asleep at UCLH at 07:17, then walking on Barn Rise — **10 km away** — at
08:48, with no travel between. A teleport. The mechanism is the *same shape*
as the 06-22 rail bug, in a different pass: `derivePlaceForSleep`
(`src/sleep/load.ts`) resolves the sleep location by nearest *stationary*
label **in time**, and `continue`s past every moving segment — so it never
looks at the Barn Rise walk's GPS, which *pins* the wake-up position to
Wembley. It discards the hardest available evidence and there is no
position-continuity gate to reject the result (`worldline-feasibility.ts`
checks only `rail-discontinuity` / `degenerate-train-leg` — mode continuity,
not position). A residential-preference patch was tried and **reverted**: it
forced Home over the nearer hospital, which then broke the 2026-05-25 /
06-02 *inpatient* nights (where the next move genuinely *was* at the
hospital). That failure is the lesson — the right answer is not "prefer
Home", it is "sleep position must be continuous with the bracketing GPS",
which keeps Home on 06-24 and the hospital on the inpatient nights for the
same structural reason. The worldline invariant (Phase 0 below) must extend
to: **a stay/sleep place must be reachable from the adjacent observed
position.**

### Measured 2026-06-24 — why the cutover is gated, not flipped

Fresh numbers that set the migration's no-regression bar. `npm run
score-decoder` (real `decodeHsmm` vs ground truth) vs `--source pipeline`:
per-minute **mode** decoder 76.7% > pipeline 70.6%; **line** decoder ~50%
≪ pipeline 98%; journey **trips** decoder 48% < pipeline 52%. The two
models are each better at a *different* dimension, so neither can be crowned
wholesale — and both wholesale swaps tried this session *measured to
regress* against the golden truth layer (baseline 15 unmet / 4 cleared):
flipping `USE_FACTOR_SCORER=1` cost **+15** confirmed-truth regressions; a
symmetric decoder train-*demotion* cost **+4** (the decoder's train recall
is too low — its silence is not evidence against a train). Phase 3's cutover
must therefore close the decoder's *line* gap first (feed the pipeline's
98%-accurate line attribution in as an emission), and every phase carries the
hard bar: golden truth clears ≥ regressions, impossibility count = 0. A new
instrument shipped this session for exactly this gate:
`tests/classification-snapshot.test.ts` — a committed synthetic CI net
pinning per-segment `(mode, wayName)` under both flag states.

The prior art already named this ceiling. `2026-05-joint-sequence-model.md`:
"a class of bugs cannot be fixed by tightening any individual pass… the principled
fix is a joint sequence decoder — score whole day-shapes." That shipped an HSMM
that scores per-minute `(mode, place, line)` sequences and owns *place*
attribution. But the **timeline's moving-leg mode and the journey structure still
come from the cascade** (`applyHsmmPlaceOverride` only overrides place, and
*weighted* movement→train; `place-override.ts:69` deliberately does not contradict
segment mode). So the decoder scores a sequence of *labels*; it does not yet own a
*worldline*. The impossibility lives in the part the decoder doesn't own.

## The thesis: feasibility belongs in the hypothesis space

Stop producing a path and filtering it. Define a model whose **support is exactly
the set of physically-realizable journeys**, and infer within it. Then:

- "arrive X / depart Y≠X" is not forbidden by a rule — it is **not expressible**.
- `#175` (share a station), `#181` (valid `(board, line, alight)` triple),
  `#176` (walking can't exceed motorised speed), `#234` (rail can't follow a road)
  stop being code and become **consequences** of "the latent path is a single
  connected walk through a multimodal network, observed with noise."

The latent object is a **worldline**: a continuous trajectory through space-time
that alternates *dwell at a place* and *travel between places via a mode*, where
mode determines feasible support (rails / roads / ~anywhere) and feasible dynamics
(a speed/accel envelope). Observations — GPS-with-accuracy, HR, steps, cadence —
are noisy *emissions* of this latent worldline. We want the MAP worldline (and its
posterior) given all observations.

## The model

**A unified multimodal spatiotemporal graph.** One graph carrying all modes:
nodes are positions / stations / intersections; edges are walk- / drive- / rail-
segments tagged with mode and (for rail) line membership; **interchange edges** are
the *only* places mode may change — stations for board/alight, kerbside / door for
walk↔vehicle. Most substrate already exists, unintegrated: `RouteGraph`
(`route-graph.ts`) already ingests *all* `osm_lines` edges (not just rail) with a
spatial index (`edgesNear`), though its station nodes are rail-only
(`route-graph-loader.ts:189`); roads are loaded per-leg via
`osm.drivableRoads()` (`road-match.ts`); the walkable surface lives as a soft prior
in `pedestrian-smooth.ts`. **Unify these into one graph** and add interchange
edges. This *is* the substrate `2026-06-map-constrained-positioning.md` asks for,
generalized from "draw position on the map" to "the journey lives on the map."

**State = a point on the graph + mode.** The latent journey is a *path*: a
sequence of states each contiguous with the next in the graph. This single choice
is the whole point — it makes, **by construction and unbreakably**: no teleports
(adjacent states share a node), board = previous alight (a train leg's first node
is where the prior leg's last node was), and no line that doesn't connect its
endpoints (the path traverses that line's edges). Every continuity rule we hand-
wrote is now a structural invariant.

**Emission = map-matching likelihood.** Position likelihood is the
accuracy-weighted, heavy-tailed distance from each fix to the candidate edge (the
Newson–Krumm HMM map-matching emission, already used cosmetically in
`road-match.ts` and as a smoother in `pedestrian-smooth.ts`). A bad fix
self-attenuates under *every* hypothesis and contributes ≈nothing — the
"weight evidence, don't hard-filter" principle, applied to the most important
input. Plus the biometric emission per mode (HR / cadence likelihood — reuse the
existing factor library).

**Transition = graph adjacency + mode-change cost + dynamics.** Move only to a
graph-adjacent edge, at a speed feasible for the mode (the envelope replaces the
`enforcePhysicalConstraints` veto, `segments.ts:236`), changing mode only on an
interchange edge (a calibrated cost, not ±∞).

**GPS gaps are inferred, not reconstructed — this is the 2026-06-22 bug, dissolved.**
When GPS drops underground, there is *no separate reconstruction stage*. The
transition model **marginalizes over connected paths** between the last surface fix
and the reacquisition fix, given elapsed time and the mode's dynamics. The tube
ride emerges as the most probable connected rail path between board and alight —
one continuous leg, never a second fabricated one, because gap-filling is the same
inference as everything else. There is no seam between "observed" and
"reconstructed" for an impossibility to hide in. The one-stop-hop fix already
shipped (`train-hop-duration.ts`, 2026-06-22) is a miniature of exactly this:
let the structural generator vouch a leg the per-minute heuristics couldn't.

**Confidence = posterior marginals.** Forward–backward over the worldline gives a
real per-leg posterior. Where evidence underdetermines the line (GPS absent, two
lines both connect board↔alight) the model says "Met or Circle" honestly; where
nothing is observable it emits `unknown` (`2026-05-honest-gaps.md`) instead of
fabricating precision. This replaces the per-segment ratio confidence
(`segments.ts:36`) that has no cross-leg meaning.

## What this subsumes

This is not a new direction; it is the **convergence** of the open proposals into
one estimator. Each existing proposal becomes an *arm* of the worldline model:

| Proposal | Role in the worldline model |
|---|---|
| `2026-06-map-constrained-positioning` | The **position** arm — emission/likelihood that puts the path *on* the map. |
| `2026-06-pedestrian-trajectory-smoother` (shipped) | The walking-leg positional emission, already a MAP smoother with a soft surface prior. |
| `2026-05-constraint-first-decoder` | The **structure** arm — the `(board, line, alight)` generator becomes the rail-edge transition support. |
| `2026-05-joint-sequence-model` / `2026-05-hsmm-physical-constraints` (shipped) | The **inference** shell — Viterbi + duration priors, reused over the worldline state space. |
| `2026-06-decoder-owns-mode` (#257) | Completed: the decoder owns mode *because* it owns the worldline, not via a downstream override. |
| `2026-06-tube-journey-segment` | Rendering: a journey is a contiguous run of the worldline; grouping is a read, not a reconstruction. |
| `2026-06-truth-engine` (#250) | The measurement substrate that gates each migration phase. |

**The one cautionary precedent — and why this differs.**
`2026-05-route-aware-decoder.md` is **superseded**: it already promoted state to
`(mode, route, position)` via an inner edge-Viterbi, and "Phase 1 proper regressed
mode by 0.6 pp." That is the trap to avoid. The difference here is deliberate:

1. **Position enters as a continuous map-matching *emission*, not a blown-up
   discrete edge state.** The route-aware attempt multiplied the state space by
   every rail edge and paid for it in the mode score. Here the worldline is a path
   whose positional cost is the map-matching likelihood; edge identity is recovered
   from the path, not enumerated as independent states per minute.
2. **The graph is multimodal**, not rail-only. The route-aware edge-Viterbi could
   only structure train minutes; walking/driving stayed free-space, so it couldn't
   express continuity *across* a board/alight boundary — exactly where today's bug
   lives.
3. **Gap-filling is first-class**, so the coarse-fix underground case (the source of
   the 2026-06-22 phantom) is handled by the model, not a bolt-on stage that the
   route-aware decoder left to `underground-rail.ts`.

If, despite this, a phased build cannot beat the current mode/place/line numbers on
the blessed eval, that is the signal to stop — same gate that retired the
route-aware decoder. This proposal is staged precisely so that test happens early
and cheaply.

## Inference

- **MAP worldline:** Viterbi / beam search over the graph state space. The beam is
  essential — the gap-marginalization is combinatorial (many connected paths across
  a long underground gap), so prune to the top-K connected continuations per step.
- **Posterior:** forward–backward for per-leg marginals → confidence + honest
  ambiguity.
- **Determinism:** reuse the frozen-fixture harness (`2026-06-deterministic-fixtures`,
  `npm run golden`) so the decode is replayable zero-DB.

## Migration plan

Staged, each phase golden-gated against the **ground-truth narratives**
(never pipeline output), retiring cascade passes only as the model demonstrably
covers them. No big-bang rewrite; the worldline decoder runs *behind the existing
output* and is compared before it takes authority.

- **Phase 0 — measurement.** Stand up a worldline-level eval in the truth engine
  (#250): a corpus invariant checker (no teleports; every train leg's board = prior
  leg's alight; every `(board, line, alight)` graph-connected) run over *current*
  output, to quantify how often we emit impossibilities today. This is the
  regression baseline and ships value immediately (it would have caught 2026-06-22).
- **Phase 1 — unify the graph.** Extend `RouteGraph` / `route-graph-loader` to carry
  drivable + walkable edges and interchange nodes alongside rail, with the spatial
  index. Pure data; nothing decodes on it yet. (Overlaps map-constrained-positioning
  Phase 1.)
- **Phase 2 — map-matching emission.** Position likelihood = accuracy-weighted
  fix→edge distance, reusing `road-match.ts` / `pedestrian-smooth.ts` cores. This is
  map-constrained-positioning's estimator, promoted from display to a likelihood.
- **Phase 3 — worldline decode.** Lift `decodeHsmm`'s state space (`state-space.ts:30`)
  from `(mode, place, line, edge?)` to a graph-path state; add the
  adjacency/interchange transition and gap-marginalization. Run it *shadow* — decode
  the worldline, render from it into a parallel timeline, diff against the cascade on
  the golden corpus. Take authority only when mode/place/line ≥ current and
  impossibility count = 0.
- **Phase 4 — retire the cascade.** As the worldline covers them, delete the passes
  it subsumes (`2026-05-constraint-first-decoder` Phase 5 / #226):
  `railRuns`, `undergroundRail`, `interchange*`, `railReconcile`,
  `mergeSameRouteTrains`, the movement→train override. The pipeline collapses toward
  *positioning → worldline decode → render*.

## Acceptance & invariants

- **Hard invariant (CI / golden):** zero physically-impossible worldlines across the
  corpus — no teleport between consecutive states (**including a stay/sleep place
  vs the adjacent observed GPS** — the 2026-06-24 UCLH→Barn Rise jump); every train
  leg boards where the previous train leg alighted; every train leg is a
  graph-connected `(board, line, alight)` triple. This is an *assertion on the
  output*, cheap, and independent of the model — keep it even before Phase 3 (it is
  Phase 0). It extends `worldline-feasibility.ts`, which today checks rail continuity
  only, with a `position-teleport` kind.
- **No regression:** mode / place / line scores on the blessed days hold or improve,
  judged against ground-truth narratives, not pipeline output
  (`2026-06-golden-osm-drift`).
- **Honesty:** ambiguous legs surface posterior uncertainty; unobservable spans emit
  `unknown` rather than a fabricated leg.

## Risks & tradeoffs

- **The map becomes load-bearing.** An OSM gap is today a wrong *label*; here it
  could block a feasible *path*. Mitigation (and a hard requirement): a missing edge
  must *lower probability*, never hard-zero a real ride — the same soft-evidence
  stance as the train soft-prior (`train-generator-prior.ts`). The route graph's
  rail coverage gaps (#238, west-London station truncation history) are a real
  exposure to size first.
- **Inference cost.** Worldline beam decode is heavier than per-minute Viterbi; the
  gap-marginalization needs disciplined pruning. The existing 288 s route-graph load
  (the cron amortizes it; the request path must not pay it) is the latency budget to
  respect — keep the heavy decode in the offline cron + cache, request path reads the
  cache (`fast-ux-offline-precision`).
- **Calibration.** One joint model means emission/dynamics/interchange costs must be
  tuned against ground truth day-by-day; this is the careful part, as the
  route-aware regression showed.
- **It is a real build, not an afternoon.** The honest comparison: the continuity
  *patch* (make `undergroundRail` / a final pass reject a leg whose board ≠ the prior
  train's alight) buys *this* bug cheaply and should probably ship now as a stopgap;
  the worldline model buys the *entire class* over several phases. They are not
  mutually exclusive — the patch is a Phase 0 guardrail that the invariant checker
  later makes redundant.

## Relationship & status

Proposed. Supersedes nothing yet; it is the **integration target** that
`2026-05-constraint-first-decoder`, `2026-05-joint-sequence-model`,
`2026-06-map-constrained-positioning`, and `2026-06-decoder-owns-mode` (#257) all
point at. When Phase 3 takes authority, those move to `archive/` with a pointer
here, and the shipped result is summarized in `docs/design/`.
