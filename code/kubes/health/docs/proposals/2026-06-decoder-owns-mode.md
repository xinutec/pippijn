---
created: 2026-06-12
status: design
references:
  - ../design/probabilistic-principles.md
  - 2026-05-constraint-first-decoder.md
  - 2026-05-scored-classification.md
  - 2026-06-tube-journey-segment.md
  - ../design/rail-snap.md
---

# Make the decoder own MODE — retire the heuristic refinement stack

This is the umbrella program that sequences existing threads toward one
goal:

> The joint probabilistic decoder, not the heuristic refinement stack,
> decides the user-facing **mode** of every segment — and the ~16
> hand-coded mode passes that exist today are retired into it.

It does not invent new architecture. The generator/scorer split is
designed (`2026-05-constraint-first-decoder.md`); the composition layer is
designed (`2026-06-tube-journey-segment.md`). This doc states the
*ownership*, the *cutover*, the *retirement*, and the one genuinely new
piece (buses), and orders them so every step ships and is validated
against the golden corpus.

## Why now

Every mode bug to date was fixed by a focused heuristic pass — cadence
vetoes, jitter demotions, rail-run reconciliation, interchange
absorption, the walk-split, and today `splitWalksOnVehicleLeg`. Each is
individually correct and each defers the joint model. The patch count is
well past the threshold we said would justify the rewrite, and the reason
we kept deferring (fear of silent regressions) has dissolved: the golden
corpus + user-confirmed ground-truth narratives now exist as a regression
gate. Today's "walk vs **bus 38** to the clinic" case is the ceiling made
concrete: no local heuristic reliably turns a vehicle leg into a named
bus, because that needs route-network knowledge + personal-habit priors —
what a joint decoder carries and a per-segment patch cannot.

## The current reality (honest map)

The decoder is closer than "heuristic patches everywhere" suggests:

- **It already computes a per-minute mode sequence** with its own working
  emission stack — `decodeHsmm` (`src/hmm/decode.ts:116`) emits
  `(mode, placeId, lineName, trainEdgeId)` per minute at ~95% mode
  accuracy on the blessed days. So mode *and* a scorer for it already
  exist inside the decoder.
- **But the decoder only owns PLACE.** `applyHsmmPlaceOverride`
  (`src/hmm/place-override.ts`, the `hsmmOverride` pass in `velocity.ts`)
  overrides the stay's place and weakly nudges driving→train. The
  user-facing **mode** is still `refinedMode ?? mode` from the heuristic
  stack (the ~16 passes).
- **What's missing is the *generator*, not the scorer.** The decoder
  enumerates the cartesian product of `(mode, place, line)` and scores it;
  most of that space is physically impossible (a train with no valid
  board/alight, a 60 km/h walk). The hard constraints that prune it are
  mostly unbuilt: Phase 1.5 mode-class lock (`mode-class-lock.ts`) shipped;
  the train-triple generator (C1) is *written but not wired into the
  decode* (`train-candidate-generator.ts`, unused); C2–C5 not built; no
  bus network exists at all.

> **Note on the `src/geo/factors/` scorer (`USE_FACTOR_SCORER`).** That is
> a *different code path* — it re-scores the **heuristic pipeline's**
> `refineMode`, not the decoder's emissions (`feature-flag.ts`). It is
> orthogonal to this program: it improves the path we intend to retire.
> So it is **not** a prerequisite for the decoder and is not on this
> program's critical path. Either fold its factor library into the
> decoder's emissions later, or let it retire with the heuristic stack;
> either way it does not gate the work below.

So the real gap is: (1) make the decoder's candidate set *physically
valid* (generator constraints, incl. buses), (2) *let the decoder's mode
through* to the user (cutover), (3) remove the heuristics it replaces.

## Target architecture

Three layers (from the existing proposals):

1. **Generator — enumerate only physically possible state sequences.**
   Hard/soft structural constraints prune the hypothesis space *before*
   ranking (full spec in `2026-05-constraint-first-decoder.md`):
   C1 train `(board, line, alight)` triple; **C-bus** vehicle leg = a bus
   route or a taxi/car (new, below); C2 walking ≤ 12 km/h; C3 stationary
   spatial coherence; C4 adjacent segments share an endpoint; C5 sleep
   place near the last pre-sleep fix.
2. **Scorer — rank the survivors** with the per-minute factor library the
   decoder *already has* (speed/HR/cadence/place-distance/duration/
   hour-of-day). No new scorer needed.
3. **Composition — group per-minute modes into the events a human
   narrates** (a tube journey = train + intra-station walk + platform
   wait), per `2026-06-tube-journey-segment.md`. Keeps the per-minute
   physics honest while the timeline reads at journey level. This is a
   hard dependency of the cutover (below).

When this owns mode, the heuristic mode passes *are* these constraints,
hand-coded one bug at a time — so they get deleted.

## The new piece: buses as a route layer (C-bus)

Today's `bus-evidence.ts` (#247) already separates bus from taxi as a
*weighted factor* — by where the vehicle stops relative to `bus_stop`
nodes. It is disciplined, not fragile; but it works from stop **dwells**,
not the **route network**, so it can't name a route and fires
inconsistently on short rides with few dwells (today's Green Park→clinic
leg). C-bus **extends** it with the network, mirroring what rail does for
trains — and, critically, mirroring rail-snap's hard-won lesson that **fix
positions are not load-bearing in this GPS regime** (per-fix map-matching
"shipped and was reverted three times", `rail-snap.md`):

- **Mirror OSM `route=bus` relations** (each route's ordered stop list +
  ways) into a `bus_route_cache`, populated by a **throttled, off-request-
  path cron** mirroring `refresh-rail-routes`. (The dormant `osm_way_routes`
  table can hold it, but only with the throttling discipline that got it
  dropped the first time — `rail-snap.md` rejected-approaches.)
- **Match by stops, not by fixes.** A vehicle leg is a candidate `bus @ R`
  iff it boards within R_stop of a stop on R and alights within R_stop of
  a *later* stop on R, with the boarded/alighted stops in route order.
  GPS-path map-match to R's ways is a *weak tie-breaker only* — never the
  primary signal — exactly as rail-snap is station-anchored, not
  fix-anchored. A leg matching no route's stop sequence stays `driving`
  (taxi/car).
- **Personal route prior** breaks the unavoidable ties: parallel routes
  share a road (the 38 and others run the same corridor), so structure
  alone often can't pick *which* route — the prior "this origin→
  destination, this time, this route, repeatedly" is what resolves it,
  the way memory does from three fixes.

**Named failure modes** (so we don't pretend it's clean): parallel routes
on a shared road (resolved only by the personal prior or by which stops
the sparse fixes actually hit); part-bus-part-walk legs (handled by the
same split logic that exists today); and a real bus ride whose sparse path
fails to stop-match → mis-degraded to taxi (a false-negative the current
dwell factor wouldn't make — so C-bus *augments* bus-evidence's score, it
doesn't replace its signal).

### Fastest path to "bus 38", decoupled from the whole program

C-bus needs **none of C2–C5 or the cutover**. The smallest shippable win
is: add the `bus_route_cache` + a bus-route factor *on top of today's
`bus-evidence.ts`*, in the existing heuristic pipeline, behind the golden
gate. That names the bus now, independently. The full decoder program
below is the principled endpoint; this is the value that doesn't have to
wait for it. We are doing the program — but C-bus is sequenced **early**
(Phase 2), not last, precisely because it's the motivating outcome and
depends on nothing downstream.

## Phased plan

Each phase ships independently, leaves the system shippable, and is gated
by the golden corpus + ground-truth truth-check. Estimates are rough; the
sequencing is the point.

- **Phase 1 — wire the train generator (C1) as a soft prior.** The
  generator exists (`train-candidate-generator.ts`); wire it into the
  decode. **Soft prior, not a hard `-∞` filter** — the earlier hard-filter
  wiring regressed when sparse/absent post-alight fixes made a *real* ride
  fall outside the candidate set (`2026-06-tube-journey-segment.md`). The
  generator strongly favours valid `(board, line, alight)` triples but
  degrades gracefully. Expected: line score (stuck at 0/6) improves
  materially — not necessarily to 6/6, since parallel central-London
  tunnels stay soft-ambiguous. (~1 wk.)
- **Phase 2 — buses (C-bus).** Mirror bus routes (throttled cron), add the
  stop-anchored bus-route factor + personal route prior, extending
  `bus-evidence.ts`. Directly addresses "driving" → "bus 38", and is
  shippable on the heuristic path *before* the cutover (the fastest-path
  note above). (~2–3 wk incl. the mirror job; longer than it looks because
  the transferable part of rail-snap is the station-anchoring, not
  map-matching.)
- **Phase 3 — physical generator constraints (C2–C5).** Walking veto,
  stationary coherence, cross-segment continuity, sleep-window coherence,
  per `constraint-first-decoder.md` Phases 2–4. **C4 (continuity) is the
  hard one** — it augments the Viterbi state with endpoint context and is
  the phase most likely to slip; it also subsumes the most heuristics (the
  reconcile/absorb passes). (~6–8 wk.)
- **Phase 4 — the cutover (the ownership flip).** Take the user-facing
  mode from the decoder's per-minute sequence (composed via the
  tube-journey wrapper) instead of `refinedMode ?? mode`, behind a flag in
  `velocity.ts`, only where a **per-segment decoder confidence** clears a
  tuned bar — *that confidence is itself a deliverable of this phase* (the
  decode emits no calibrated per-segment confidence today). The heuristic
  mode stays the fallback for low-confidence/no-decode days. Gate:
  **journey-level truth-check parity — no ground-truth narrative
  regresses** (not byte-for-byte; the decoder is deliberately honest about
  intra-station interchange walks that the narrative folds into the
  journey, which only the composition layer reconciles). (~1–2 wk incl.
  validation.)
- **Phase 5 — retire the heuristic mode passes.** Delete the mode-deciding
  passes one at a time, each behind a no-regression check + `CLASSIFIER_
  VERSION` bump + full re-decode. **Not pure subtraction:** the structural
  passes (reconcile/absorb/splits) map onto C1–C4 and are safe to delete;
  the *scorer-side* passes (`revertIsolatedCadenceDrives`,
  `demoteJitterWalkToStationary`, the cadence corrections) encode emission
  knowledge the decoder must be shown to *reproduce* before deletion, not
  assumed. Land a per-pass subsumption table (à la
  `constraint-first-decoder.md`'s factor-retirement table) as part of this
  phase. (~1–2 wk.)

Phases 1–3 are independently valuable before the cutover (better decode,
better audit, and — via Phase 2 — the named bus on the heuristic path). 4
is the heavily-gated ownership flip. 5 is mostly subtraction, with the
cadence/jitter caveat.

### Measured 2026-06-13: a premature segment-level mode flip was rejected

An attempt to shortcut to Phase 4 — let the decoder's dominant per-segment
mode (support fraction ≥ 0.6) override the pipeline's, with no composition
layer and no calibrated confidence — was built, unit-tested, and run
against the golden gate. Result: **0 wins, 2 regressions.** It flipped a
real `12:41–12:52 driving on Fulton Road` (05-25, ground-truth driving) to
walking and shuffled a 05-20 drive away; it did **not** fire on the 06-12
interchange it was meant to fix, because that day's decode does not call
those minutes walking either. Root cause: the decoder's aggregate per-minute
mode edge (≈76% vs 71%) does **not** transfer to per-segment ownership —
the HSMM systematically under-detects short road-vehicle drives as walking,
exactly where the pipeline carries drivable-road-corridor evidence. This
confirms the phase ordering: the cutover needs C-bus + C2–C5 (so the decode
itself is right) and a calibrated per-segment confidence (so the flip is
gated on evidence, not a bare support fraction), not a raw mode-override
seam. Reverted; no code from the attempt remains.

### Measured 2026-06-16: baseline established + the decoder already wins the case the heuristic can't

Two measurements taken on the real 2026-06-16 clinic day (tube + bus out,
Victoria→change→Metropolitan back) set the target and validate the design:

- **Decoder baseline (`score-decoder`, 7-day decoded_days corpus):**
  per-minute `mode 75.6% · line 50.0%`; journey `trips 48.0% ·
  leg-modes 74.5% · leg-lines 50.0%`. **Trips 48% is the number to beat**
  — below the heuristic pipeline's ~52% — and it is the single quantity
  that gates the cutover. The per-minute strength (76%) not transferring
  to trips is the same under-reconstruction the 06-13 attempt hit.
- **The decoder already reconstructs the return the heuristic mangles**
  (`compare-hmm-vs-heuristic --date 2026-06-16`): at 16:31 and **16:37** it
  emits `train | Victoria Line` — 16:37 being the exact minute the heuristic
  pipeline draws a phantom `walking on Eversholt Street` — and `train |
  Metropolitan Line` for the leg home, naming both lines. No local heuristic
  recovers this; the joint model does. This is the concrete proof the
  ownership flip is worth finishing.
- **The decoder's two gaps, made concrete on the same run:** (1) **no bus
  in the decoder state space** — it labels the bus-38 leg (12:21–12:23)
  `train | Piccadilly Line`, snapping a road vehicle onto the nearest tube
  line; (2) **fragmentation** — it leaves the deep-tube Jubilee minutes
  (12:11–12:13) `unknown`. (1) is decoder-side C-bus; (2) is C4 continuity.
- **The decoder is not even running on the live timeline:** the 2026-06-16
  fixture's `hsmmDecode` is null — today's map is 100% the heuristic
  pipeline. The smart brain is built and measured but switched off.

**Distinction this sharpens (corrected 2026-06-16 after reading the decode):**
the C-bus work shipped 2026-06-15/16 (stop-anchored route matcher +
intermediate-stop corroboration, `bus-route-match.ts`, #256) lives on the
**heuristic path** — it names the bus *there*. The decoder's remaining job is
**NOT** to add a `bus` mode: there is no `bus` `TransportMode` anywhere
(`segments.ts` — bus is a *display* mode derived from `driving` +
`vehicleKind:"bus"` in `day-state.ts:176`). The decoder's actual failure on
the 06-16 bus-38 leg is that it emitted `train | Piccadilly Line` at road
speed *with GPS present* (12:21–12:23, 13–23 km/h) — it **credited a rail
line to a road vehicle** because `line-proximity-factor.ts` scores `train @ L`
by GPS-to-track distance, and the bus's road runs parallel to the Piccadilly
tunnel. (Not `route-rail-evidence.ts`, which fires only on GPS-null minutes.)
So the real decoder brick is **#238**: gate rail credit on the trajectory
*following the track / not following a drivable road* — the decoder twin of
the bus-corroboration fix already shipped on the pipeline. Once the leg
decodes `driving`, the existing C-bus annotation names it `bus` (composition,
Phase 4). Heuristic-path C-bus is done; the decoder #238 rail-over-credit
fix is the remaining piece, and it is delicate probabilistic-scoring work
(the #238/#241/#234 family) that MUST be validated against the
`score-decoder` baseline + golden before it ships.

**Confirmed next bricks, in order (each measured against the 48%/76%/50%
baseline, never re-blessed against decoder output alone):** decoder-side
bus mode → C4 continuity (the fragmentation / trip-structure fix) →
calibrated per-segment confidence → cutover (Phase 4) gated on
journey-level parity. Capture 2026-06-16 (return + morning) into the
decoded_days corpus as the headline acceptance day.

## Validation discipline (the reason this is safe now)

- **The golden corpus is the gate.** 13 fixture days replay zero-DB
  (`npm run golden`); **11 of them carry user-confirmed ground-truth
  narratives** that the truth-check scores each decode against (verified /
  cleared / regressed). No phase ships if any narrative regresses. This is
  the safety net that did not exist when the rewrite was first deferred.
- **Synthetic, no-private-data tests already exist** under
  `tests/scenarios/` (phantom-cycling, tube-as-driving, board-station,
  etc.). What's still missing (task #103) is a *classification-snapshot CI
  gate* that fails on an unversioned label change — a prerequisite for
  Phase 5's retirements, since the real fixtures are gitignored and CI
  can't see them.
- **Every phase lands with a real-data failing acceptance test** under
  `tests/scenarios/`, referencing a captured fixture + its ground-truth
  narrative — the discipline `constraint-first-decoder.md` already sets.
- **Parity tools must mirror prod env** (the `USE_FACTOR_SCORER` gating
  lesson): the golden/backtest harnesses propagate every gating flag, so
  "passes locally" means "matches prod".

## Honest risks and what's deferred

- **C4 (continuity) is the schedule risk** and the highest-value phase.
- **The labelling-convention friction is real** and is why the
  tube-journey composition layer is a hard dependency of the cutover, not
  an afterthought — and why the cutover gate is journey-level, not
  per-minute.
- **The decoder's own emission stack, not `src/geo/factors/`, is what it
  ranks with.** Unifying the two factor libraries is desirable but is *not*
  on this critical path; don't let factor-scorer work block the program.
- **Deferred:** full per-user *learned* emissions
  (`2026-05-hmm-learned-emissions.md`) beyond the current fits; can follow
  the cutover without blocking it.

## Relationship to existing proposals

This is the **umbrella**. Component plans it sequences:
`2026-05-constraint-first-decoder.md` (the C1–C5 generator constraints —
Phases 1, 3) and `2026-06-tube-journey-segment.md` (the composition layer
— dependency of Phase 4). What this doc adds that none of them own: the
**bus/route layer** (Phase 2), the explicit **cutover** that makes the
decoder authoritative for mode (Phase 4), and the explicit **retirement**
of the heuristic mode stack (Phase 5). The `src/geo/factors/`
scored-classification roadmap is explicitly *off* this critical path.
