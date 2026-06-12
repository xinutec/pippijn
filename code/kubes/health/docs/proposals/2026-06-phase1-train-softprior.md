---
created: 2026-06-12
updated: 2026-06-12
status: design
references:
  - 2026-06-decoder-owns-mode.md
  - 2026-05-constraint-first-decoder.md
  - 2026-06-tube-journey-segment.md
---

# Phase 1 — wire the train generator as a soft per-segment prior

First phase of `2026-06-decoder-owns-mode.md`. Goal: make the decoder's
**line attribution** (which tube line a `train` segment is) come from
*structural validity* — a real `(board, line, alight)` triple on the
route graph — instead of only the soft per-minute proximity factors that
have left the line score stuck at **0/6**.

> Revised after adversarial review. The first draft attached the prior as
> a per-minute *emission* term and kept the existing line factors live
> alongside it; both were wrong (mid-segment line flips + triple-counting).
> The corrected design below is a per-segment **entry** prior that **gates
> off** the per-minute line factors on covered windows.

## What exists, and the decisions this phase makes

- `enumerateTrainCandidates` (`src/hmm/train-candidate-generator.ts`) is
  written and tested but unused in the decode: for each train-speed (or
  bracketed-displacement tube) window it emits every `(board, line,
  alight)` triple whose endpoints are real stations on the line,
  graph-connected on the line's edge subgraph. `startMin`/`endMin` are
  **array indices** into the `observations` it is given.
- The decode (`src/hmm/decode.ts:147-148`) sums a per-minute emission
  `baseEmission + geometricFn + routeRailFn + lineProximityFn`, and passes
  a per-segment `entryLogProb` (`hsmm-viterbi.ts:65,176`, built at
  `decode.ts:150`) that fires once at each segment start.

Two decisions:

1. **Soft, not hard.** The generator was documented as a hard `-∞`
   filter. We wire it **soft** because it requires a station within
   `R_STATION_M = 250 m` of the board/alight GPS context
   (`train-candidate-generator.ts:66`); sparse post-tube GPS can resurface
   >250 m from the station POI, so the generator can emit *no* candidate
   for a **real** ride. A hard filter would zero that real train out — the
   regression `2026-06-tube-journey-segment.md` records. Soft strongly
   favours valid triples and never forbids a train the generator missed.
2. **Per-segment, not per-minute.** A train segment's line is one
   commitment for the whole ride; `groupStatesIntoSegments` splits a
   segment wherever the per-minute line changes (`persist.ts` `sameState`
   keys on `lineName`). A per-minute boost can therefore flip lines
   mid-ride. So the prior attaches at the **entry layer** (once per
   segment start), making line a per-segment decision.

## The mechanism

Computed once per decode, after `dropGpsOutliers`, on the **same** tensor
the Viterbi iterates (so `startMin` indices align):

1. `const cands = enumerateTrainCandidates({ observations: tensor, routeGraph, knownLines: KNOWN_LINES })`.
2. Build a coverage map keyed by **`obs.ts`** (unique, contiguous in the
   1440-minute tensor). For each candidate window `[startMin, endMin]`,
   mark `coverage[tensor[m].ts] = { window, lines }` for `m ∈ [start,end]`.
   **Per-window line sets — never union across windows.** Windows are
   disjoint by construction (`findTrainWindows`), so each covered minute
   belongs to exactly one window; use *that* window's line set. (Union
   would bless a Met line on an interchange minute that is structurally
   Jubilee-only.)
3. **Entry prior** `trainGeneratorEntry(state, startTs)` composed into the
   existing `entryLogProb`:
   - `state.mode !== "train"` → `0`.
   - `state.lineName === "unknown_rail"` → `0` (the graceful-degradation
     escape hatch; the two kept factors already exempt it — never penalise
     it, or a generator-missed ride loses its fallback).
   - segment start `startTs` **not covered** → `0` (generator silent here;
     the per-minute factors carry this window — see gating below).
   - covered, `state.lineName ∈ coverage.lines` → `+BOOST`.
   - covered, `state.lineName ∉ coverage.lines` → `−PENALTY`.
4. **Gate the per-minute line factors off on covered minutes** so they do
   not double-count with the entry prior. Pass the coverage map into
   `buildRouteRailEvidence` / `buildLineProximityFactor`; for a `train`
   state on a **covered** minute they return `0` (the entry prior owns
   line attribution there). On **uncovered** minutes they are unchanged —
   that is how a generator-missed ride still gets a line. This is the
   honest form of "retire route-rail / line-proximity once C1 ships"
   (constraint-first Phase 5): on covered windows C1 *has* replaced them;
   off-window they remain until a later phase covers those cases too.

Net: covered windows → generator (per-segment, structural). Uncovered →
existing per-minute factors. No double-count, no mid-segment flip.

## Calibration

Anchor `BOOST`/`PENALTY` to the **transition-cost scale**, not a number
hand-fit to 11 days. The kept factors derive their magnitudes from the
~5-nat cross-state transition cost (`line-proximity-factor.ts:53-56`); the
generator prior should too: `PENALTY` large enough that a structurally
invalid line loses to a valid one *within* train (overcome line-inertia)
but not so large it overcomes **mode**-inertia and pushes a train segment
to `driving`. Start near the transition scale (≈ −5 to −8) and fine-tune
against `compare-vs-ground-truth`, watching that **mode/place accuracy
does not regress** while line accuracy rises — calibration, not sharpness.

## Acceptance tests (write first; must fail before the wiring)

- **Real-data contract (on `decodeHsmm`, not just the generator):** decode
  the captured `2026-05-22` fixture (`tests/golden/days/` +
  `tests/golden/decoded_days/2026-05-22-pippijn.json`) and score it with
  `score-day` against `tests/golden/ground-truth/2026-05-22.md`. Assert the
  **line score rises from 0/6**, and the correct line is chosen for the
  train minutes the decoder already calls `train`. *Bound to acknowledge:*
  `score-day` only counts a line on minutes where both GT and decoder say
  `train` — so a train minute the decoder still mislabels `driving` can't
  contribute; the score is bounded by mode-correct train minutes.
- **Synthetic unit:** board context near Wembley Park, alight near Green
  Park → the generator emits **no `Metropolitan Line`** candidate (no Met
  station at Green Park) but does emit the valid Jubilee triple; the entry
  prior penalises `train @ Met` and favours `train @ Jubilee` over that
  window. Public station coordinates as test inputs; abstract scenario.

## Determinism and downstream

- **Pure/deterministic.** `enumerateTrainCandidates` reads only
  `inputs.routeGraph` + the tensor (both already in `HsmmInputs`); it makes
  **no** new OSM/network lookups, so computing candidates inside
  `decodeHsmm` keeps it replayable against captured fixtures. Run it after
  `dropGpsOutliers`, reusing the tensor `decode.ts` already built.
- **It can shift user-facing mode now (gate accordingly).** Phase 1 changes
  the decode, which feeds `applyHsmmPlaceOverride`'s driving→train nudge
  (`place-override.ts` `decideHsmmTrainOverride`, gated on
  `lineOverlapFraction > roadCorridorFraction`). Better line attribution —
  and especially turning a previously-`unknown_rail` window into a
  **named** line — can newly make a segment eligible for that override, so
  the set of *changed days* can include days where a vehicle leg newly
  becomes `train`, not just days where a line label changed. The gate is
  therefore **not** "golden states unchanged": re-run the golden
  truth-check; every changed day is verified against its ground-truth
  narrative — improvements re-blessed, any contradicted narrative blocks.

## Assumption + scope

Phase 1 assumes the **line-only** train state space (`decode.ts:127`
passes `knownLines`, so train states carry a `KNOWN_LINES` name that
matches `candidate.line`). If a later phase enables per-edge `railEdges`
states (whose `lineName` may be null), the name-match must be revisited.

## Done when

- Both acceptance tests green.
- `compare-vs-ground-truth` line score up, no mode/place regression across
  the blessed days.
- Golden truth-check: every changed day verified against ground truth,
  re-blessed where it's an improvement, zero contradicted narratives.
- Verify (typecheck/lint/tests) + golden green; ship; `CLASSIFIER_VERSION`
  bump + re-decode of cached days.
