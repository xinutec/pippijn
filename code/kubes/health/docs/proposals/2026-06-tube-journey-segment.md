---
created: 2026-06-01
updated: 2026-06-01
status: design
references:
  - ../design/probabilistic-principles.md
  - 2026-05-constraint-first-decoder.md
  - 2026-05-physical-plausibility.md
---

# Tube journey as a segment-composition unit

## Why this proposal now

The constraint-first decoder (Phase 1.5, mode-class lock) is live
and producing an honest per-minute classification: cadence + GPS +
window-aggregated displacement decide foot / vehicle / stationary
deterministically where the physical facts allow. On 2026-05-22
the decoder correctly identifies the Victoria Line ride
(15:30-15:38, L:match), correctly identifies the Wembley → Baker
StStreet train ride, and *correctly* identifies the 2-3 minute
inter-platform walk at Baker Street as walking because the user
actually was walking — cadence-confirmed.

The ground-truth tables and the existing pipeline (task #165,
interchange absorber) absorb that inter-platform walk into the
surrounding train segments under a labelling convention: a Tube
journey from Wembley Park to Green Park via Baker Street is
written as two train rows with the walk subsumed. The decoder
being *honest* about the walking minutes is then scored as a
mismatch against that convention — the 13:26-13:35 Jubilee row
shows M=2/9 on the eval not because the decoder is wrong about
what happened, but because the eval is comparing labels at a
granularity the convention has already smoothed over.

Pippijn's framing for the resolution: combine consecutive
train rides + intra-station walks + platform waits into a single
**tube journey** segment from surface-entry to surface-exit. The
per-minute decoder underneath remains accurate (cadence-confirmed
walking stays walking, fast-moving train stays train); the
labelling layer presents one event per logical journey, the way
a human narrates the day. The eval then compares at the
tube-journey level — the granularity the decoder was always
ultimately answering at.

## The concept

A **tube journey** is a single segment with the shape:

```
TubeJourney {
  surfaceEntry: stationNode  (where the user entered the tube system)
  surfaceExit:  stationNode  (where the user emerged from the tube system)
  startTs, endTs
  legs: [
    { line: "Metropolitan Line", board: WembleyPark, alight: BakerStreet, startTs, endTs },
    { kind: "interchangeWalk", station: BakerStreet, startTs, endTs },
    { line: "Jubilee Line",       board: BakerStreet, alight: GreenPark, startTs, endTs },
  ]
  totalStepsInside: 234   // from cadence accumulated across the journey
}
```

The single segment is what the UI renders and what the eval
scores. The inner legs are inspectable data — the line list, the
boarding / alighting stations, the steps the user actually took
inside the system — but they're not separately-labelled segments
in the timeline. A four-minute Baker Street interchange is *part
of* the tube journey, not a competing classification.

Why this composition matches the data: every minute inside a tube
journey is one of three physical facts the mode-class lock
already decides — moving fast underground (vehicle), walking
between platforms (foot), or briefly stationary at a platform
(stationary). The tube-journey wrapper says only that *the
context of all these minutes is the same logical journey*, not
that the physical-fact lock should change.

## How it composes with the rest of the architecture

The decoder pipeline becomes three layers, in order:

1. **Per-minute classification (existing).** Mode-class lock + HSMM
   + factor library produce a `(mode, place, line)` label per
   minute. Cadence > 0 stays foot; vehicle-class stays vehicle.
   The lock from
   [`2026-05-constraint-first-decoder.md`](./2026-05-constraint-first-decoder.md)
   Phase 1.5 is unchanged.

2. **Train-candidate generator (Phase 1 of constraint-first).**
   Emits `(board, line, alight)` triples per train run. Wired as
   a soft prior rather than a hard filter (the earlier hard-
   filter wiring regressed; see Phase 1 entry in the
   constraint-first proposal).

3. **Tube-journey assembler (NEW, this proposal).** Walks the
   per-minute classification and the generator's train candidates,
   composes them into tube-journey segments:

   - A run of consecutive minutes whose per-minute classification
     is `vehicle` or `foot-inside-station` (foot + GPS near a
     station POI), bracketed by surface walking, is a tube
     journey.
   - The train-candidate generator's outputs name the lines and
     stations of the inner legs.
   - The foot-locked minutes inside the run between trains become
     `interchangeWalk` legs, not standalone walking segments.

4. **Output (UI + eval + persistence).** The journey-level
   segment is the rendered unit. Per-minute classifications are
   carried through as inner data; the step count for the day
   still correctly attributes the inter-platform walks to
   walking even though the parent segment is "tube".

Crucially: the per-minute classification doesn't change shape.
The tube-journey segment is *additional* structure — a wrapper
that knows about the contiguous run. Removing the assembler would
leave the existing per-minute decode untouched.

## Implications for each system surface

### Eval

The 5-day eval compares the decoder's segments to the ground-
truth segments. If the GT continues to use the absorb-walk-into-
train convention, the comparison becomes:

  decoded tube-journey { Met-leg, walk, Jubilee-leg }
    ⇔ GT { "train Wembley → Baker", "train Baker → Green" }

The comparison is at the journey level: was the right tube
journey identified, were the right lines used, were the right
board / alight stations identified? This is a much fairer metric
than per-minute mode equality across the interchange.

Both lines used in the journey appear in the line-match check —
the journey carries `lines: ["Metropolitan Line", "Jubilee
Line"]`, the GT carries two train rows with each line. Match if
the line *sets* coincide.

The intra-station walking minutes stop being a mismatch source —
the journey absorbs them, the GT absorbs them, both agree.

### UI

A tube-journey shows up as one timeline item:

```
13:16 – 13:35    Tube · Wembley Park → Green Park
                 via Met to Baker Street, Jubilee to Green Park
                 234 walking steps within the journey
```

Drilling in (a click, an expansion) shows the leg-level structure.
This is closer to how a human reads their day than three rows
"train, walking 2 min, train".

### Persistence

`decoded_days` becomes a tree, not a flat list. A tube-journey
row owns sub-leg rows. The schema gets a column or a JSON blob
for the inner-leg list.

Alternative simpler shape: keep the flat per-minute decoded list
unchanged; add a `tube_journeys` table that points into runs of
minutes by (start_ts, end_ts, line_list, board_station,
alight_station). This is the lighter footprint and is the route
this proposal recommends as the first cut.

### Decoder

No state-space change in the HSMM itself. The tube-journey
assembler is a *post-decode* pass that reads the HSMM output and
the train-candidate generator's emitted candidates, then groups
the per-minute classification into journey segments.

Composing the assembler:

- Walk the decoded state list left to right.
- Maintain a "currently inside a tube journey?" flag.
- A foot-locked minute near a station POI flips the flag on (or
  keeps it on); a vehicle-locked minute on rail-line geometry
  flips it on.
- A foot-locked minute *outside* any station POI flips it off
  (surface exit).
- A run with the flag on is one tube journey.
- The train-candidate generator's output (which lines, which
  stations) names the legs within the journey.

The assembler is deterministic and pure — no new model, no
probabilistic scoring. It just composes signals the decoder
already produced.

## What this generalises to

The "tube journey" concept is one specific case of a more general
pattern: a *trip* that consists of multiple segments at different
modes but constitutes one logical event.

- **Drive trip**: continuous driving + brief stationary stops
  (red lights, parking pauses) = one drive trip from origin to
  destination.
- **Commute**: walking + tube + walking from home to work = one
  commute.
- **Multi-leg flight**: takeoff + cruise + landing + transfer +
  takeoff = one journey.

Each of these is a candidate for the same wrapper pattern:
inner physical-fact minute-level labels, outer trip-level
segment that the UI and eval treat as atomic.

This proposal commits only to tube journeys as the first concrete
instance. The wrapper pattern is the architectural unlock; the
others follow when their evidence cases motivate them.

## What this is NOT

- **Not** a change to the per-minute decoder. The mode-class lock,
  HSMM, factor library, train-candidate generator all stay as
  they are.
- **Not** a new state space. The HSMM still operates on
  `(mode, place, line)`.
- **Not** a labelling concession that hides physical reality.
  The cadence-confirmed walking minutes inside a tube journey
  are still counted as walking steps in the daily step total —
  they just aren't *labelled* as a separate "walking" timeline
  item.
- **Not** a hard-coded tube schedule. The assembler uses only
  the per-minute classification + the route graph + the
  generator's candidates, all derived from physical signals.

## Phasing

| Phase | Work | Output |
|---|---|---|
| A | Eval shape: extend `compare-vs-ground-truth` to match decoded tube-journey segments against runs of train+walking rows in the GT. | New `--journey` mode in the eval that scores journey-level rather than per-minute. |
| B | Tube-journey assembler module + tests. Pure function: takes the decoded per-minute state list + train-candidate-generator's output + route graph, returns a list of `TubeJourney` segments overlaid on the per-minute decode. | `src/hmm/tube-journey-assembler.ts` |
| C | Persistence: add `tube_journeys` table (start_ts, end_ts, line_list, board_station, alight_station, intra_step_count). Update the `decoded_days` writer to populate it alongside the existing per-minute rows. | Migration + writer. |
| D | UI: render tube-journey segments as single timeline items with expand-to-legs interaction. | Frontend. |
| E | (Generalization, deferred) Apply the same wrapper to drive trips and commutes once the tube case has settled and the abstraction is proven. | Future. |

Phase A is the smallest piece that proves the architecture: if
the eval at the journey level shows the score going up, the
underlying decoder was right all along and the labelling
convention was the wedge. Phase B-D follow.

## Decision

Recommend committing. The constraint-first decoder produces an
honest per-minute classification; the convention friction is at
the labelling layer; the tube-journey wrapper resolves it by
adding a composition unit that matches both the user's mental
model and the labelling convention without distorting the
per-minute physics.

## Decision log

- 2026-06-01 — proposal drafted in response to Pippijn's framing:
  "If you want to combine them into a single tube (which may
  include combined sequences that can't strictly be a single
  tube), that's fine. Is that easier or harder?" The answer is
  *easier* — the per-minute decoder stays correct, the eval and
  UI become cleaner, and the labelling convention stops
  competing with physical facts.
