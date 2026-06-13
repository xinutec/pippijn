---
created: 2026-06-13
updated: 2026-06-13
status: on-hold — premise undercut; pending re-measure on re-captured fixtures
references:
  - 2026-06-truth-engine.md
  - 2026-06-phase1-train-softprior.md
  - 2026-05-route-aware-decoder.md
  - 2026-06-decoder-baseline (memory)
---

# Tunnel-transit coherence — stop the decoder fragmenting GPS-dark rides

> ## STATUS — do not implement as written (2026-06-13)
>
> Two things landed after this was drafted:
>
> 1. **Adversarial review found blocking flaws in the proposed factor.**
>    - The #238 taxi guard is **false**: the road-vs-rail discriminator
>      (`line-proximity-factor.ts`) returns 0 on GPS-null minutes, so on
>      exactly the dark minutes this factor targets, nothing keeps a boosted
>      "vehicle" off the rails — and the mode prior already favours `train`
>      over `driving`, while `route-rail-evidence` adds +3.5 to train. A
>      line-agnostic +1 boost would *compound* the train bias, risking a
>      #238 regression.
>    - It **ignores `geometric-feasibility.ts`**, which already penalises
>      `stationary @ knownPlace` on displaced dark minutes (teleport-speed
>      check). The new factor double-counts there; the genuine gaps it leaves
>      are `stationary @ none`, `walking`, and the `unknown` escape hatch.
>    - The flat −5/+1 is the wrong shape (accumulates over sparse-GPS
>      windows); should be implied-speed-scaled with an explicit max-gap
>      duration; `prevGpsFix`/`nextGpsFix` are **whole-gap bookends**, so the
>      guard must be implied *speed*, not raw displacement.
>
> 2. **The motivating measurement was on stale data.** `score-decoder`'s
>    decoder trip-structure baseline (33%) was computed with 05-15 and 05-25
>    fixtures captured *before* the osm_points station-truncation fix
>    ([[project_health_osm_points_truncation]]). Those route graphs are
>    missing the stations the user actually boarded at (on 05-15 the nearest
>    station to every morning fix is 889 m–2.3 km away), so the train
>    generator finds **0 candidates** and the ride fragments. The
>    re-captured day (05-22) does not fragment (44 candidates, trips 60%).
>
> **Therefore:** re-capture 05-15 / 05-25 with the osm_points fix and
> re-run `npm run score-decoder` first. The fragmentation may largely
> evaporate. Only the *residual* fragmentation on correct data justifies new
> decode logic — and if it does, the cleaner lever is likely the **generator**
> (per-segment, already produces one segment, already gates the per-minute
> factors) rather than a fourth per-minute factor. The original proposal
> below is kept for the record; it is **not** the plan.

## Problem (measured)

The HSMM decoder fragments underground tube rides. Real fixture 2026-05-15,
a ~12-minute Wembley Park → central tube ride decodes as:

```
08:44–08:55  walking
08:55–09:08  stationary  (13m)   ┐
09:08–09:15  unknown     (7m)    │ the GPS-dark ride, shattered
09:15–09:20  stationary  (5m)    │
09:20–09:22  train Jubilee (2m)  ┘ only a 2-min sliver kept as train
09:22–09:40  walking
```

`npm run score-decoder` quantifies the cost: decoder **trip-structure 33%**
vs the heuristic pipeline's 52%, even though the decoder's per-minute mode
(75%) already beats the pipeline (71%). Nearly every London day is a tube
day, so this one failure mode dominates the decoder's journey quality and
blocks "decoder owns mode".

## Root cause

On a GPS-null minute (underground), the per-minute emission systematically
favours `stationary` over `train`:

- `stationary` gets a **coherent** signal: the speed-Gaussian fires at
  0 km/h (`emissions.ts` speed term), plus the strong stationary mode prior
  (`log 0.7`), plus the off-network prior pulling unobserved GPS toward a
  stay.
- `train` gets only the weak movement mode prior (`log 0.05`) and **no**
  positive per-minute evidence — the speed term is skipped when GPS is null.
  Its only lifelines are *line-level* and brittle:
  - `route-rail-evidence` requires the gap's two bookends to both sit on
    **underground edges of the same line** AND a connectivity BFS to
    succeed — it returns 0 whenever a bookend is surface-side, the line
    isn't a `knownLine`, or the per-line graph doesn't connect.
  - the train generator's soft entry prior only fires when a candidate
    window was produced (stations within 250 m of board/alight + path on
    the line) — sparse post-tube GPS routinely misses it.

So across the dark minutes train is **starved of evidence** and the Viterbi
prefers `stationary`/`unknown`. This is a **mode-level** failure (movement
vs stay), not a line-level one — yet the only signals that could fix it are
line-level. That mismatch is the bug.

## The principle

A GPS-dark stretch bracketed by two fixes that are **far apart** is, by
physics, *movement* — you cannot be sitting still and reappear kilometres
away. The bookend displacement is information the dark minute itself lacks;
it lives in the **sequence**, exactly where an HSMM should use it. The
decoder already computes this displacement for the *generator*
(`findTrainWindows` bracketed-displacement pathway) but never lets it reach
the per-minute Viterbi at the **mode** level.

## Design — a per-minute "tunnel-transit" factor

A new factor `buildTunnelTransitFactor`, composed additively into the
emission like `route-rail-evidence` / `line-proximity-factor`. It decomposes
the rule into the project's two halves
([[feedback_layer2_rules_must_decompose]], [[feedback_weighted_over_binary]]):

- **Impossibility half (strong, the real fix).** On a GPS-null minute whose
  bracketing `(prevGpsFix, nextGpsFix)` implies sustained **vehicle-speed
  displacement** (distance ≥ `MIN_DIST_M`, implied speed ≥ `V_MOVE_KMH`,
  gap within a sane duration), `stationary` and `walking` are
  near-impossible — apply a **large negative** term to those modes. You did
  not sit still across a 4 km gap.
- **Evidence half (modest).** The same minute IS some vehicle mode — apply a
  **small positive** term to the vehicle modes (`train`, `driving`/`bus`).
  Which one, and which line, is left to the existing weighted factors
  (`route-rail-evidence`, `line-proximity`, the road-vs-rail #234 signal,
  the generator prior). This factor is deliberately **line-agnostic**: it
  fixes the *fragmentation*, not the *attribution*.

Net: the dark minutes get a continuous "this is a ride" pressure that
overcomes stationary's coherence, so the Viterbi keeps one `train` (or
`driving`) segment across the gap; line/mode-within-vehicle stays with the
factors built for it.

### Why not just loosen route-rail-evidence / the generator
Those are line-level and brittle by nature (a tube ride that surfaces at an
interchange, or whose post-alight GPS lands 300 m from the station POI,
legitimately breaks their assumptions). Loosening their thresholds trades
one brittleness for another and risks the #238 taxi-as-rail regression.
The fragmentation is a *mode* problem; fixing it at the mode level is
cleaner, line-agnostic, and leaves the (correct, conservative) line factors
untouched.

### The critical guard (why this is safe)
The factor fires **only when the bookend fixes are far apart**. Indoor GPS
loss while genuinely sitting (a café, an office) has `prev ≈ next` — small
displacement → factor does not fire → stationary is unaffected. The whole
correctness of the term rests on requiring real displacement, not merely
GPS absence. This is also why it cannot resurrect #238: a taxi that follows
roads still displaces, so the factor (correctly) says "vehicle" — but it
boosts `driving` too, and the road-vs-rail factor keeps it off the rails.

### Magnitudes
Anchor to the ~3-nat stationary-vs-train mode-prior gap: the stationary
penalty must exceed it decisively (so train wins the dark minutes) without
being a hard ∞ (a real, rare stationary-with-displacement artefact — GPS
teleport outlier — should still be recoverable). Start near `−5` for the
stationary/walking penalty and `+1` for the vehicle boost; calibrate
against `score-decoder` watching that mode/line do not regress while trips
rise.

## Acceptance (write first, TDD)

- **Unit** (`tests/tunnel-transit-factor.test.ts`): a GPS-null minute with
  `prev`/`next` 4 km apart over 12 min → strong negative for `stationary`
  & `walking`, small positive for `train`/`driving`, `0` for a minute whose
  `prev ≈ next` (indoor sit), `0` when GPS is present.
- **Real-data** (`npm run score-decoder`): on 2026-05-15 the morning tube
  ride decodes as **one** train journey, not five fragments — trip-structure
  rises; 2026-05-22 underground day holds or improves; **2026-05-25 taxi
  stays `driving`, never gains phantom rail** (#238 guard).
- **Golden** (`npm run golden-hsmm`): re-bless changed days only after
  verifying each against its ground-truth narrative; the taxi day must not
  regress.

## Done when

- Unit + real-data acceptance green; `score-decoder` trip-structure up with
  no mode/line regression; #238 taxi unchanged.
- Verify (typecheck/lint/tests) + golden green; commit. (Prod decode already
  consumes `decodeHsmm`, so this ships with the normal decode path; gate the
  deploy on the same golden + ground-truth check.)
