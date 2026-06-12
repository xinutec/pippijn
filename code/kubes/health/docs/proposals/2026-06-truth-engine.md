---
created: 2026-06-12
status: design
references:
  - 2026-06-decoder-owns-mode.md
  - 2026-05-constraint-first-decoder.md
  - 2026-06-phase1-train-softprior.md
  - 2026-06-tube-journey-segment.md
  - probabilistic-principles.md
---

# The truth engine — a multi-sensor, physically-grounded, honest day decoder

## Goal

Reconstruct what *physically actually happened* in a day from GPS, the
Fitbit watch (heart rate, cadence, steps, sleep stages), and a model of
physical reality + personal habit — and **say so with calibrated honesty**:
precise where the evidence supports it, explicitly uncertain where it
doesn't.

The bar is **not** "match Google Maps Timeline." Google infers mode from
GPS + phone accelerometer for an anonymous device in real time, with no
biometrics, no personal history, and no licence to say "unsure." It is a
low floor. The bar here is *physical truth for one known person's life
log*, which is a different and higher target — and one our inputs uniquely
support:

- **Personal history + route structure is the main edge.** "Takes the
  Jubilee," "rides the 38," "never cycles" ([[user_cycling]]), "this café
  is also where he sometimes works" are priors Google structurally cannot
  hold — and for the failure modes that actually hurt (which bus, which
  tube line, bus-vs-taxi) the discriminator is the *route network + habit*,
  not the sensors. This is the load-bearing edge; do not mis-attribute it
  to biometrics.
- **Biometrics disambiguate a NARROW but real set.** HR/cadence cleanly
  separate exertion modes — cycling vs sitting, walking-cadence vs carried.
  They are decisive for cycling-veto and walk detection. They are **near
  useless** for bus-vs-taxi-vs-train (all "sitting passenger," low cadence,
  resting HR): HR-vetoing those over-fired and caused the morning-tube-as-
  walking regression, so HR is soft-only there
  ([[project_health_cadence_driving_overfire]], #139/#140). Weight effort
  accordingly — biometric tuning cannot move the bus/line numbers.
- **Offline recompute + honesty.** We are not on a latency budget. We can
  decode the whole day jointly, revise as later evidence arrives, and
  publish uncertainty instead of a confident guess.

> **This is a bespoke decoder for one life, not a general classifier.**
> One user, ~11 confirmed days. Every learned component overfits to one
> person's recent fortnight unless guarded — which is *correct* here (the
> priors should be that personal), but it means the win is fidelity to one
> known life, not a model that generalises.

## Philosophy (the fusion principles)

Carried from `probabilistic-principles.md`, made the spine of the engine:

1. **One hidden truth, many noisy emissions.** The day is a hidden
   sequence of `(mode, place|route, line)` states. Every sensor is a noisy
   measurement *of that one truth* — never decided independently per
   stream and reconciled after.
2. **Physical impossibility is a hard constraint; everything else is
   weighted evidence.** A train alighting at a station that line doesn't
   serve is *impossible* (pruned). A fix being 200 m from the track is
   *evidence* (weighted). Never encode the second as a veto.
   ([[feedback_weighted_over_binary]], [[feedback_model_impossibilities_as_constraints]])
3. **The sequence carries information a single minute lacks.** You don't
   teleport between modes; rides have realistic durations; a journey is
   one intent (home → tube → bus → clinic), not four unrelated legs.
4. **Personal priors are graduated belief, not hardcodes.** Learned from
   history, updated by evidence, never an `if user == pippijn` branch.
   ([[feedback_weight_dont_filter]])
5. **Expose uncertainty.** Honest low confidence beats fabricated
   precision. ([[project_health_sync_quality_bar]])

## Architecture — six layers

```
 L0  Sensor alignment      GPS + HR + cadence + steps + sleep → per-minute observation tensor
 L1  Generators            per mode, propose only PHYSICALLY-REAL legs (prune the impossible)
 L2  Scorer                rank survivors by joint multi-sensor likelihood (weighted evidence)
 L3  Sequence decode       HSMM Viterbi: durations + transitions + journey assembly
 L4  Personal priors       learned habitual routes/places/modes as graduated belief
 L5  Uncertainty + render  calibrated confidence; "unknown" where data is thin
```

### L0 — Sensor alignment (exists)
`buildObservationTensor` already fuses the streams onto a 1440-minute grid
with rail/road proximity per minute. Solid. Extends to carry whatever new
emissions a generator/scorer needs (e.g. per-minute HR reserve).

### L1 — Generators: physical reality per mode
A generator for mode *M* enumerates legs that *can exist* in the world.

> **Honest caveat (from review): generators are soft, not hard, for any
> mode with sparse GPS.** The train generator began as a hard `−∞` filter
> and *regressed* — sparse/absent post-alight fixes put a *real* ride
> outside the candidate set, so a hard filter zeroed a true ride. It is now
> a **soft entry prior** with an `isCovered` gate. So Principle 2's clean
> "prune impossible / weight plausible" split is real only where coverage
> is dense; where it's sparse, L1 *is* a strong term in L2, not a separate
> layer. Bus (sparser fixes, denser parallel routes) will be soft from day
> one. The architecture must own this, not pretend L1 and L2 are clean
> tiers for the modes that matter.

- **train** — real `(board, line, alight)`, stations real & graph-connected
  on the line. *Built and now wired as a soft prior*
  (`train-candidate-generator.ts`, [[project_health_238_root_cause]]). The
  osm_points truncation that starved it is fixed
  ([[project_health_osm_points_truncation]]). Open: #238 taxi-as-rail and
  the soft-prior's residual `unknown_rail` are not closed — "train" is
  *advanced*, not *done*.
- **bus** — the flagship target, and **bigger than it looks** (review B1).
  It needs three things none of which exist yet: (a) a `bus` mode in the
  decoder state space + duration/transition priors (today `bus` is only a
  display-time `vehicleKind` annotation on a `driving` segment — there is
  no bus state, `src/hmm/state-space.ts`); (b) **OSM route-relation
  mirroring** — bus route identity ("the 38") lives in `route=bus` /
  `route_master` relations, which the mirror drops entirely
  (`osm-local.ts` returns null for relations); bus *ways* carry no per-way
  route name the way rail tracks do, so there is no shortcut. (c) a stop→
  route index for the train-style membership/sequence check. Until (a)–(c)
  land, the most we can say is "road vehicle, probably a bus" (the existing
  `bus-evidence.ts` stop-dwell scorer), never "the 38." Treat bus as a
  multi-week substrate effort (route-relation mirror), not a quick win.
- **walk** — footpath-plausible speed/distance; not crossing the
  uncrossable.
- **drive / taxi** — road-followable trace; bus-vs-taxi separated by
  route-match + stop-dwell pattern ([[project_health_cadence_driving_overfire]], #247).
- **cycle** — near-zero prior for this user; emitted only on strong
  evidence ([[user_cycling]]).
- **stay / sleep** — place generators (focus places, lodging POIs, sleep
  windows). Largely exists.

### L2 — Scorer: joint multi-sensor likelihood
Every surviving hypothesis scored by how well it explains **all** sensors
at once — the factor scorer (`src/geo/factors/`) is the substrate:

- **speed/geometry** — does the trace move and bend like this mode on this
  infrastructure?
- **heart rate** — exertion consistent? (cycling HR ≫ sitting-on-train HR;
  an implausibly low HR vetoes nothing but weighs heavily — #139)
- **cadence / steps** — walking has a step rhythm; a vehicle does not (#141, #242).
- **road-vs-rail proximity** — does the trace hug rail or follow roads?
  (#234, #238) — the per-minute discriminator that keeps a taxi off the
  Circle Line.
- **biometric mode signatures** — learned per-user per-mode HR/cadence
  profiles (#82/#83).

Weighted log-likelihoods, summed. Binary only for true invariants.

### L3 — Sequence decode: the day as one coherent story
HSMM Viterbi (`decodeHsmm`) over the per-minute state space with realistic
**durations** and **transition** costs, so the decode is globally coherent
rather than locally greedy. Above it, **journey assembly**
(`tube-journey-assembler.ts`) groups legs into intents. The end state:
**the decoder owns MODE end-to-end**, fed by L1 generators + L2 scores,
retiring the ~16 heuristic refinement passes in `velocity.ts`
([[project_health_sync_hmm_debt]]).

### L4 — Personal priors: learned habit as belief
A per-user model of habitual journeys: lines ridden, buses taken, routine
places and their time-of-day profiles (`focus_places` hour profiles +
visit weights already exist; extend to *routes*). Feeds L1 (propose the
habitual leg) and L2 (weight it up) as graduated belief.

> **Provenance firewall (review M6) — the rule that stops the feedback
> loop.** Full-recompute does *not* break self-reinforcement: recomputing a
> prior over a window of the decoder's own past *output* is a fixed point,
> not a divergent accumulator — it relabels the same way forever (this is
> phantom cycling, [[user_cycling]], generalised to routes). The guard is
> **provenance, not recompute frequency**: L4 priors may be built only from
> `derived` / `user` / `corroborated` signal — raw GPS dwell, user
> statements, confirmed ground truth — and **never** from the decoder's own
> emitted `inferred` mode/place/line labels. `focus_places` hour-profiles,
> which are derived from past pipeline output, must be audited against this
> rule before they feed L4. ([[ground-truth provenance ladder]],
> [[feedback_weight_dont_filter]])

### L5 — Uncertainty and rendering
Each emitted segment carries a calibrated confidence. Thin-data stretches
render as low-confidence or `unknown` ([[feedback_honest_gaps]] / #194)
rather than an invented precise claim. Surfaced in "Your Day" and the
`analyze-day` CLI ([[feedback_cli_mirrors_ui]]).

## What exists vs what's needed

| Layer | Exists | Needed |
|------|--------|--------|
| L0 sensors | observation tensor, rail/road proximity | new emissions as L2 grows |
| L1 generators | train ✓ wired; stay/sleep ✓ | **bus**, walk, drive/taxi as first-class generators |
| L2 scorer | factor scorer + most factors | unify behind one path; calibrate weights vs ground truth |
| L3 decode | HSMM owns place; journey assembler | **decoder owns mode**; retire heuristic stack |
| L4 priors | place hour-profiles, biometric sigs | **personal-route model** |
| L5 honesty | `unknown` gaps, confidence field | calibrated confidence + UI surfacing |

Most of the skeleton is built. The work is completing the generators,
moving mode ownership into the decoder, adding the personal-route layer,
and surfacing honesty — not a rewrite.

## Phasing — measurement first

The review's decisive correction: **the evaluation apparatus the whole
plan rests on does not exist**, so every phase's "ships only when the score
rises" gate is currently a phantom. Build the measurement before the modes
— you cannot build "much smarter" against a metric that can't move.

0. **Foundation (done this session).** osm_points station fix + train
   line prior. 05-22 line 0/6 → 3/6; #238 taxi still `unknown_rail`.
1. **Measurement foundation (NEW — do first).**
   - Make road-vehicle truth **scorable**: extend `DecoderMode` +
     `canonicalMode` (`score-day.ts`) so a blessed `bus` row scores against
     the decoder's road-vehicle output (today it can *never* match — the
     flagship metric literally cannot move). Surface `vehicleKind=bus`.
   - **Journey-level scorer** — the cutover gate referenced everywhere is
     unbuilt. Score whole journeys (this trip = home→tube→bus→clinic), not
     just per-minute, against the ground-truth narratives.
   - **Confidence calibration** — emit a confidence per segment and a
     reliability/Brier/ECE metric, so "calibrated honesty" is *measured*,
     not asserted.
   - Grow the confirmed-day corpus (single highest-leverage input).
2. **Bus substrate + mode** — route-relation mirror + `bus` decoder mode +
   bus generator (now measurable thanks to Phase 1). Fixes 06-12.
3. **Decoder owns mode** — route mode through L1+L2+L3; retire heuristic
   passes *one cluster at a time*, each gated on the journey-level metric.
   Not pure subtraction: place/label/render passes (jitter consolidation,
   station-at-alight, place attribution) are entangled with OSM I/O the
   pure `decodeHsmm` forbids; the cutover is a data-flow *inversion*
   (today the heuristic pipeline is authoritative and the HSMM *overrides*
   place via `applyHsmmPlaceOverride`), not a deletion.
4. **Personal-route model** — learn habitual journeys (provenance-gated);
   wire as L4 belief. Note: bus route disambiguation on shared corridors
   *depends* on this, so bus stays ambiguous-by-design until L4 lands.
5. **Retire the legacy stack** — `velocity.ts` mode passes removed as the
   decoder is *proven* (not assumed) to reproduce their emission knowledge.

Each phase: design note → adversarial review → TDD against a captured real
day → golden + ground-truth validation → ship. ([[feedback_tdd_first]],
[[feedback_real_data_test_fixtures]], [[feedback_golden_osm_drift]])

## Evaluation — the bar (and its current gaps)

`compare-vs-ground-truth` scores mode/place/line **per minute** against
user-confirmed narratives (`tests/golden/ground-truth/`, 11 days). A change
ships only when the score rises with no regression. Known gaps the
measurement-foundation phase closes:

- **Per-minute only.** No journey-level metric exists, yet the cutover gate
  is defined as journey-level no-regression. Build it.
- **`bus` unscorable.** `canonicalMode` doesn't relate bus to the decoder's
  road-vehicle output, so the flagship row can't score.
- **Confidence uncalibrated.** No confidence emitted, no calibration metric
  — the headline "honesty" value has no apparatus.
- **Thin corpus.** Tuning the line term against ~6 scorable minutes on one
  day risks overfit. Growing the confirmed-day corpus is the single
  highest-leverage input. ([[project_health_sync_golden_ground_truth]])

## Open inputs from the user (refine the design; not blocking)

1. More confirmed days (rough is fine) — calibration + personal-route fuel.
2. Habitual lines / buses / routes / usual places — seeds L4.
3. Physical-reality facts about himself (drives? car? walking pace? modes
   never used?) — hard constraints + strong priors.
4. Which wrongness annoys most (mode / place / line / false precision) —
   weights the effort.
