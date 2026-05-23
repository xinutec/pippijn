---
created: 2026-05-23
updated: 2026-05-23
status: vision
---

# Physical plausibility + logical coherence as the quality bar

The current "your day" output is full of cases where the literal pipeline
output is physically or logically wrong: sleep attributed to a hospital the
user demonstrably left before midnight; a 5-minute "driving on Pentonville
Road" sandwiched between two same-venue stays; a 3-minute "train" between
two non-adjacent stations; a sleep label of "Plein 1944 187" when the
guesthouse is 5 m away; a 3-hour phantom walk filling a signal gap.

Each is locally a different bug. Globally they share a shape: **the
pipeline manufactures false structure to fill gaps in the data, and never
checks whether the manufactured structure is physically possible or makes
sense as a narrative.**

The bar: a "your day" output that a human reads and immediately accepts as
*plausible*. Wrong-in-details is acceptable; absurd-on-its-face is not.

## What "physically plausible + logically sensible" means concretely

- **Proximity to a name-bearing place** (lodging, venue, named building)
  outranks proximity to a nearest-address. If a sleep window's centroid is
  5 m from a `tourism=guest_house`, the answer is the guesthouse, not the
  street address.

- **Activity-type / POI-type coherence**. Sleep windows snap to lodging or
  residence. Meal-time stationary stays snap to food POIs. Hospital-time
  stationary stays snap to medical POIs. Generic stationary snaps to the
  nearest typed POI of any kind before falling back to an address.

- **Physical bounds**. A train segment is at minimum
  `expected_travel_time(board, alight) / 2`. A motorised peak speed is not
  walking (#176). Cycling needs HR + cadence to plausibly support it. A
  speed > 200 km/h is plane, not train.

- **Transition logic**. Two same-place stationary stays flanking a brief
  moving segment is one stay (#183 / #185). A mode change requires either
  a physically-plausible interchange (station, road junction) or a
  time-coherent narrative.

- **Honest "don't know"**. When signals genuinely conflict or are too
  sparse, the output says so. "Sleeping somewhere near Plein 1944 (low
  confidence)" beats "Sleeping @ Plein 1944 187" if the latter is
  fabricated precision.

## Architecture

### Layer 1 — OSM POI type as a first-class signal

The local OSM mirror has type tags on `osm_points` and `osm_lines`, but
the place-prior scorer mostly consumes mined focus_places + nearest-address
lookups. The mirror's typed POIs (lodging, restaurant, hospital, station,
etc.) should be candidates in their own right, weighted by:

- Type match against the activity context (sleep ↔ lodging / residence)
- Distance from the cluster centroid (Gaussian, tight σ)
- Name specificity (proper-named POI > generic-typed POI > address)

This is mostly DB + scorer wiring. The candidates are already there in
the mirror; they just aren't surfacing into pickBestPlace.

### Layer 2 — Physical-plausibility post-pass

After the segment + state pipeline produces a candidate sequence, a final
pass walks it and rewrites violations of declarative rules. Examples:

- "Two same-place stationary segments flanking a brief (<10 min) moving
  segment → merge as one stay" (replaces #183 sliver-merge with a
  general rule)
- "Train segment shorter than physical board→alight travel time →
  reclassify or split"
- "Sleep window's centroid within radius R of a `tourism=guest_house` →
  attribute place to the guesthouse"
- "Sleep window after a late stay at a `amenity=hospital`, with no
  intervening return to a residence focus_place → flag low confidence,
  don't manufacture residence label" (the inverse of #186)

Each rule lives as code + a real-data failing-day test under
`tests/scenarios/`. Shipping a rule requires the failing day to flip from
wrong-pre-rule to correct-post-rule, and no other golden day to regress.

### Layer 3 — Joint sequence model (HMM / Viterbi)

The long-term direction tracked in `project_health_sync_hmm_debt.md`.
Replaces the cascade with a single Viterbi pass over the day, with
transition priors that encode the layer-2 rules as soft constraints.
Each layer-1 / layer-2 win makes this rewrite simpler because the
priors are already articulated.

### Layer 4 — Confidence-aware rendering

Already partially shipped via #170 (confidence-gated venue label).
Tightening: an output sequence carries per-state confidence; UI
distinguishes "high confidence narrative" from "best-guess sketch
under sparse data". 04-30 should render as the latter, with most
labels visibly hedged.

## What this is NOT

- **Not a rewrite-everything**. Each layer ships independently; the
  pipeline keeps working between commits.
- **Not a full ML model**. The priors are declarative and inspectable —
  a human reviewing a day's output should be able to point at exactly
  which rule caused which decision.
- **Not over-fitting to a few golden days**. Rules need an articulated
  *reason* a human would agree with; the failing-day test exists to
  prove the rule does what it claims, not as the rule's justification.

## Order of work

1. **Layer 1, narrow first**: surface lodging POI types as place
   candidates. Failing days: 04-30 (Vertoef), and any future overnights
   at a hotel / B&B / Airbnb.
2. **Layer 1, widen**: same for food, hospital, transit POIs. Eats most
   of the place-naming failures from #173, #185, #187.
3. **Layer 2, three rules**: same-place sliver merge generalised
   (#183 superseded); train-validity (#181); sleep-at-medical guard
   (the inverse of #186).
4. **Layer 4 tightening**: per-state confidence visible in the UI; OSM
   address labels marked low-confidence by default.
5. **Layer 3 design pass**: revisit when the layer-2 rule list grows
   to ~10 — at that point the priors are mature enough to encode as
   transitions in a Viterbi pass without guessing.
