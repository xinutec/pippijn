---
created: 2026-05-29
updated: 2026-05-31
status: superseded
supersededBy: decoder-roadmap.md
references:
  - ../design/probabilistic-principles.md
  - decoder-roadmap.md
  - 2026-05-joint-sequence-model.md
  - 2026-05-hmm-learned-emissions.md
  - 2026-05-hsmm-physical-constraints.md
---

# Route-aware decoder — promoting state from `mode` to `(mode, route, position)`

> **Superseded by [`decoder-roadmap.md`](./decoder-roadmap.md)**.
>
> Phases 0, 1A (route-rail-evidence), 1A++ (connectivity check),
> 1B (line-proximity-factor), and Phase 1 proper (inner-Viterbi
> hierarchical decoder) all shipped. On the 2026-05-31 eval the
> Phase 1 decoder regressed mode by 0.6 pp on 2026-05-22 and left
> the line score unchanged at 0/6. The diagnosis: a route-aware
> state space is still a per-minute scoring approach over the
> cartesian product of `(mode, place, line, edge)`. The
> per-minute factor stack the proposal proposed adding can't
> filter physically impossible candidates — only a *generator*
> can. The successor proposal articulates that architecture.
>
> The shipped code (`src/geo/route-graph.ts`,
> `src/hmm/route-rail-evidence.ts`,
> `src/hmm/line-proximity-factor.ts`,
> `src/hmm/inner-viterbi-edges.ts`,
> `src/hmm/route-aware-decoder.ts`) is in maintenance until Phase
> 5 of the constraint-first doc retires it. Route-graph
> extraction (Phase 0) survives as the substrate the
> constraint-first generator builds on.

## Why this proposal now

The HSMM landed three layers of factors today (geometric feasibility,
mode prior, rail-corridor boost) that each approximate one piece of
the same structural shift: the decoder needs to know *where on the
map* the user could physically be, not just what mode they're in.

The 2026-05-22 audit made this concrete. A 13-minute Met Line tube
ride from Pentonville Road → Finchley Road:

- Pipeline labels it "driving on Euston Underpass" because the
  surface road runs parallel to the underground rail and a straight
  line between the bookend GPS fixes crosses the road.
- HSMM (with all of today's factors) correctly knocks out
  `stationary @ Home` (geometric feasibility) but falls back to
  `stationary @ none` because the rail-corridor boost can't fire —
  King's Cross St Pancras isn't tagged as a Metropolitan Line station
  in OSM (it's under the composite "Circle, Hammersmith & City and
  Metropolitan Lines" tag).
- Neither decoder picks `train @ Metropolitan Line`, even though the
  evidence overwhelmingly supports it.

The proximate fix (expand `stationsOnLine` to match composite tags)
patches *this* case. The deeper question is why we kept ourselves
blind to it: the decoder asks "is this minute walking, train, or
stationary?" when the question that resolves it is *on which physical
route?*

Today's factor library is approximating route-awareness:

- **Geometric feasibility** is "is `stationary @ A` consistent with
  the bookend fixes given a plausible bridging mode?" — which is
  really "does there exist a route from bookend B to A to bookend C
  in the time budget?"
- **Rail-corridor boost** is "are the bookend fixes near stations on
  line L?" — which is really "is line L's track geometry consistent
  with the bookend fixes?"
- **Place-distance emission** is "is the GPS fix near place P?" —
  which is really "is the user at position P on the place-polygon?"
- **Station-graph hard-zero** is "can a `train @ L` segment alight at
  place P?" — which is really "does line L's geometry intersect P's
  walking radius?"

Each of these is a soft approximation of route geometry. Each one
papers over the gap by reading metadata (station tags, place coords)
that's incomplete in OSM. The accumulated complexity hides the
structural answer.

The structural answer is: **the state at each minute is
`(mode, route_entity, position_along_route)`, not just `mode`.**
This proposal articulates that shift.

## What changes structurally

### State space

Today:

```
State = { mode: TransportMode, placeId: number | null, lineName: string | null }
```

Proposed:

```
State = {
  mode: TransportMode,
  // The OSM feature the user is currently traversing or located on.
  // - For movement modes: an osm_lines row (road, rail, footpath,
  //   waterway). Identified by `osm_id + osm_type`.
  // - For stationary at a known place: the focus_place's polygon
  //   (or a wrapped osm_lines/osm_points entity backing it).
  // - For stationary off-network: a synthetic "anywhere" entity
  //   sized by the prev/next fix uncertainty.
  route: RouteRef,
  // Fractional position along the route, [0, 1]. For polygon
  // entities, position is 0 (interior). For very long routes
  // discretised into chunks at decode time.
  position: number,
}
```

The route graph is built once per day from `osm_lines` and `osm_points`
restricted to the user's bbox (a generous envelope around all observed
fixes for the day, plus a buffer). Routes are categorised by feature
type (rail, road, footpath, etc.) and tagged with derived attributes:

- `underground`: from `tunnel=yes` or `layer < 0` tags
- `rail_subtype`: rail / subway / light_rail / tram / narrow_gauge
- `line_membership`: parsed line names (handles composite tags
  natively)
- `way_continuity`: which ways connect to this one at endpoints

### Emission

The big shift is that GPS-presence becomes **route-conditional**, not
purely mode-conditional:

```
P(GPS-observed | state) =
  P(GPS-observed | mode, underground, current_speed)
```

For a `train @ MetLineWay#42 (underground=true)` minute at any speed,
P(GPS) ≈ 0.05 — you're in a tunnel.

For a `driving @ EustonUnderpassWay (underground=true)` minute,
P(GPS) ≈ 0.05 — also a tunnel.

For `walking @ PentonvilleRoadWay (underground=false)`, P(GPS) ≈ 0.95.

GPS-null observations are now *informative evidence* for
underground-tagged routes — not just a missing signal. This dissolves
the current emission's struggle to distinguish "phone charging at
home" from "in a tube tunnel" — they ARE distinguishable when state
carries the route's underground attribute.

When GPS IS observed, the emission factor becomes "how well does the
fix project onto the route geometry":

```
log P(GPS_fix | state) =
  log Gaussian(perpendicular distance from fix to route, σ_route)
```

where σ_route is calibrated per feature type (rail tracks tight,
footpaths looser, etc.). The current `place-distance` factor is the
zero-length-route case of this.

### Transitions

Route transitions take over from today's station-graph hard-zeros:

- From `train @ L_way` you can only transition to:
  - Another `train @ L_way'` if the two ways share an endpoint
    (continuous on line L) — or share a vertex at a station
    (interchange to another line via cross-platform).
  - `stationary @ station_polygon` if the current way ends at a
    station vertex.
  - `walking @ way` only via a `stationary @ station` intermediate.
- From `driving @ road_way` you can only transition to:
  - Adjacent road ways via the road junction graph.
  - `stationary @ parking` or `stationary @ pickup_point` adjacent
    to the road.
  - `walking @ way` via `stationary` (gotta get out of the car).

These aren't soft factors. They're properties of the graph topology.
The transition matrix becomes literal route-graph reachability.

### Continuing today's HSMM structure

Crucially, *the inference shell doesn't change*. The HSMM Viterbi /
forward-backward operates over whatever state space you give it. The
duration distributions, the entry prior, the mode prior, the per-place
HR override, the sleep observation factor — all of these remain. They
become factors over a richer state.

What disappears from the explicit factor list:

| Factor | Today | After route-aware |
|---|---|---|
| Place-distance emission | explicit factor | special case of route projection |
| Off-network log-prior | explicit constant | natural — "off-graph" state has its own emission |
| Rail-corridor boost | explicit per-minute | natural — route is rail, GPS-conditional |
| Geometric feasibility | explicit per-minute | structural — route topology bounds reachable states |
| Station-graph hard-zero | explicit `placeNearLine` | structural — route-transition graph |

What remains explicit:

| Factor | Reason it stays |
|---|---|
| Visit-frequency entry prior | Per-user place history; not in the OSM graph |
| Hour-of-day entry prior | Per-place visit-time profile; not OSM |
| Mode prior `P(mode)` | Per-user mode rate; not OSM |
| Per-place HR override | Per-user biometric prior; not OSM |
| Sleep observation factor | Per-minute Fitbit signal; orthogonal |
| Per-mode duration Gamma | Per-mode segment length; orthogonal |

So the change preserves the entire user-conditioned factor library
and replaces only the spatial-prior layer with topology and geometry.

## Concrete example walked through

The 2026-05-22 20:05-20:13 case under the route-aware decoder:

**Bookend evidence**:
- 20:03 GPS at (51.530, -0.124), 0 km/h → projects onto Pentonville
  Road footpath at position 0.4 (surface, P(GPS) high — consistent
  with observed GPS).
- 20:16 GPS at (51.547, -0.181), 5.6 km/h → projects onto Finchley
  Road area, likely the station forecourt walking-area.

**Reachable trajectories during the 13-min gap**:

| Trajectory | Path | Plausible? |
|---|---|---|
| Walking through KX Underground building → Met platform → walking out at Finchley | (walk, walk, walk) | Distance ~5 km in 13 min = walking impossible |
| Driving via Euston Underpass | (drive, drive, drive) | Possible but: emission for first/last minutes shows driving on surface roads where GPS would be present — observed GPS-null. Mismatch. |
| **Train on Met Line** | (walk into KX, train @ MetLine track between KX↔Finchley underground, walk out) | Distance matches. Time matches. GPS-null on the underground rail segment is exactly what the route's `underground=true` predicts. ✓ |

The route-aware decoder picks the Met Line trajectory because it's
the only one where the emission model *predicts* GPS-null for the
gap minutes. No tuning. No corridor boost. The geometry of the
underground rail vs the surface road is the evidence.

## Phasing

Map matching for transport classification is well-studied (Newson &
Krumm 2009 "HMM Map Matching", Goh 2012 "Online Map-Matching Based
on Hidden Markov Model for Real-Time Traffic Sensing Applications",
many follow-ups). Implementation is significant but bounded.

The right phasing builds up route-awareness for the modes where it
matters most, leaving abstract-mode behavior for the rest until each
phase ships and proves out:

### Phase 0 — Route graph extraction

A new offline cron `refresh-route-graph` that, per user, builds a
graph rooted in the bbox containing their observed-fix history:

- Nodes: way endpoints, station vertices, place polygons, road
  junctions.
- Edges: osm_lines way segments, with attributes
  (feature_type, subtype, underground, line_membership,
  surface_road_class, etc.).
- Cached per (user, geographic-region) — invalidated when OSM mirror
  refreshes or user's bbox grows.

Effort: ~1 week. Mostly SQL + graph construction in pure TS. Builds
on the existing OSM cache layer.

### Phase 1 — Route-aware `train` states only

Replace `train @ lineName` (current shape) with
`train @ rail_way_id` enumerated from the route graph. Keep all
other modes abstract (`walking`, `driving`, `stationary @ placeId`)
as today. This is the smallest viable change that fixes the 2026-05-22
Met Line case end-to-end.

Concrete changes:

- State space: train states cartesian over user's rail-way set.
- Transitions: rail-way endpoint graph; station-graph becomes a
  natural projection (station vertex connects rail ways).
- Emission: train-mode-specific factors gain underground-conditional
  GPS-presence and rail-track-distance projection.
- Eval: re-run ground-truth eval. Expect line score to improve
  meaningfully (today 3/3 was small denominator).

Subsumed factors: rail-corridor-boost retires (route geometry handles
it directly). Station-graph `placeNearLine` becomes the projection
"does place P touch any vertex on the rail way's endpoint list."

Effort: ~2 weeks. Largest piece is the train state enumeration and
the route projection geometry. Existing HSMM Viterbi takes the
augmented state space without modification.

### Phase 2 — Route-aware `walking` and `driving` states

Extend to walking and driving modes. State space grows by road and
footpath ways near the user's history.

This is the phase that fixes the pipeline's "driving on Euston
Underpass" tube mislabel from the consumer side too — once HSMM picks
`train @ Met track` for the gap, the `applyHsmmPlaceOverride` extends
to also override pipeline's `wayName` for movement segments (separate
follow-up).

Effort: ~2-3 weeks. Mostly state-space cardinality management
(walking/driving have many ways) and route-junction transition rules.

### Phase 3 — Route-aware `stationary` states

Stationary @ place becomes `stationary @ place_polygon, position=0`.
Place-distance emission collapses into the projection factor. Off-
network stationary becomes `stationary @ anywhere, position bounded
by uncertainty ellipsoid of nearest fixes`.

Effort: ~1 week. Smaller because the state shape is already
implicit in the current `placeCoords` factor.

### Phase 4 — Retire approximating factors

Once all modes are route-aware, the explicit `geometric-feasibility`,
`rail-corridor-boost`, `place-distance`, and `off-network-prior`
factors become redundant. Remove. Each removal is preceded by an
eval run confirming no regression.

Effort: ~1 week. Tests + audit.

### Total

~7-9 weeks for the full route-aware decoder. Each phase ships and
is evaluated independently — the system is incrementally better after
each phase, no all-or-nothing risk.

## What this proposal IS, and IS NOT

**IS**:

- A structural shift from "classify mode in the abstract" to
  "trajectory in the OSM graph + mode."
- Subsumes today's geometric / rail / place factors into one
  geometric framework.
- Uses data already in the mirror (osm_lines, osm_points) instead
  of approximating around tag incompleteness.
- Extends, doesn't replace, the existing HSMM Viterbi / forward-
  backward inference. Today's factor library stays intact for the
  user-conditioned signals.
- Naturally answers the per-line-track questions (Met Line through
  KX, tube tunnels with no GPS) that today's factor library
  struggles with.

**IS NOT**:

- A from-scratch rewrite. The HSMM shell, duration distributions,
  per-user priors, biometric factors, sleep observation, and the
  velocity.ts override pattern are all preserved.
- A replacement for per-user habit learning. Calibration loops over
  user-conditioned factors (per-place HR, visit frequency, mode
  rate) become more important as route adds structural correctness,
  not less.
- A solution for sparse-fix days. Routes constrain reachability but
  cannot manufacture observations. Days with one fix in the morning
  and one at night will still be underdetermined — the route-aware
  decoder will surface this as posterior spread, not a confidently
  wrong answer.
- Map matching for vehicular fleet tracking. Doesn't try to estimate
  realtime road-segment traversal at sub-second resolution. Per-
  minute is the granularity.

## What today's factor library tells us about the right scope

The current factors that ARE structural (route-shaped) vs ARE
user-conditioned (signal-shaped):

| Factor | Shape | Route-aware decoder absorbs? |
|---|---|---|
| Geometric feasibility | structural | ✓ — route topology |
| Rail-corridor boost | structural | ✓ — route is rail, GPS-conditional |
| Station-graph hard-zero | structural | ✓ — route-transition graph |
| Place-distance emission | structural | ✓ — route projection at zero length |
| Off-network log-prior | structural | ✓ — "off-graph" state emission |
| Sleep observation factor | signal | — unchanged |
| Per-place HR override | signal | — unchanged |
| Visit-frequency entry prior | signal | — unchanged |
| Hour-of-day entry prior | signal | — unchanged |
| Mode prior `P(mode)` | signal | — unchanged |
| Per-mode duration Gamma | signal (segment-shape) | — unchanged |

That split is the test of "is this proposal right-sized" — every
structural factor we have today is something the route-aware decoder
*replaces with topology*, and every user-conditioned factor stays
exactly as is.

## Decision

Recommend committing to the design. The 2026-05-22 Met Line case is
not a one-off bug — it's a representative of the class of errors
the current factor library can only approximate around. Each
incremental factor (today's geometric / rail-corridor / etc.) adds
maintenance burden without addressing the structural gap.

The first concrete step is Phase 0 (route graph extraction). It's
self-contained, low-risk, and produces a reusable artefact (the
per-user route graph) that several downstream features can read.

## Decision log placeholder

- 2026-05-29 — proposal drafted, status `design`. Awaiting Pippijn
  review.
- 2026-05-30 — Phase 0 shipped. Phase 1A (route-rail-evidence,
  bookend underground gap boost) + 1A++ (per-line connectivity
  check) + 1B (line-proximity-factor at GPS-present minutes)
  shipped as intermediate improvements. Aggregate eval moved 0pp
  on line score (0/6 → 0/6). Diagnosis: the failure mode isn't
  weak per-line evidence — it's the HSMM keeping a single
  `train @ line` segment across an underground board-change at an
  interchange station (e.g. Met → Jubilee at Baker St on 2026-05-22),
  because no per-minute factor can split a segment that's entirely
  GPS-null between bookends. Phase 1A/B were the right structural
  additions but cannot move the eval without the segmentation fix
  below.
- 2026-05-31 — committed to Phase 1 proper (per-edge state) with
  the implementation design appended below.

## Phase 1 — Implementation: hierarchical inner-outer decoder

This section is the concrete plan for Phase 1 proper. Earlier
phases (1A, 1B) were per-minute factor additions that left the
core HSMM state space unchanged at `(mode, place, line)`. Phase 1
proper is the structural change: the train state space becomes
edge-aware, decoded by a hierarchical Viterbi that respects the
distinction between *outer* mode-segment boundaries (which pay
duration cost) and *inner* edge transitions within a train run
(which do not).

### The single failure mode this fixes

Today's HSMM on 2026-05-22 produces:

```
13:18 → 13:29   train · Metropolitan Line   (HSMM, one segment)
13:18 → 13:26   train · Metropolitan Line   (ground truth, Wembley → Baker St)
13:26 → 13:35   train · Jubilee Line        (ground truth, Baker St → Green Park)
```

Both train segments are entirely underground. The HSMM has no
GPS-present minutes at the boundary (13:26). Every per-minute
factor we've layered on top (rail-corridor, route-rail-evidence,
line-proximity) is uniform across the entire 13:18–13:29 gap from
the HSMM's perspective: the prev-fix bookend is at Wembley, the
next-fix bookend is at Green Park, and these bookends don't change
as we step through the GPS-null minutes. Met-evidence at the next
bookend (Green Park) is absent, but the score is identical
whether we're at the Wembley end or the Baker St middle. The
HSMM has no information to prefer splitting at 13:26 over
keeping a single Met segment.

The only signal that *could* split the segment is the **edge
sequence**. Met track east of Baker St runs Marylebone Rd →
Great Portland St → Euston Sq → KX. Jubilee track south of
Baker St runs Bond St → Green Park → Westminster. Between
the Wembley bookend and the Green Park bookend, the only edge
path that exists on the Met subgraph alone is Wembley → Baker St
(it doesn't continue south). The only edge path on Jubilee
alone is Wembley → Baker St → Bond St → Green Park (Jubilee
goes through Wembley Park on shared track with Met).

If the decoder is forced to commit to a single edge sequence
across the full 13:18–13:29 span, no single-line path can
reach Green Park from Wembley via Met-only edges. A single-line
Jubilee path exists. So a single-line decoder would pick
Jubilee. A *segment-aware* decoder can do better: split at
Baker St and use Met for the first half (where shared track
allows it, but the Wembley → Baker St sub-path is most natural
as Met), then Jubilee for the second half. That's the win.

### State space

Outer state — same as today:

```
OuterState = { mode: TransportMode, placeId: number | null, lineName: string | null }
```

Inner state, only meaningful for `mode = train, lineName = L`:

```
InnerState = { edgeId: string }   // refers to a RouteEdge.id on line L's subgraph
```

For non-train modes, the inner state is degenerate (single
"degenerate" edge). For `train @ unknown_rail`, the inner state
is also degenerate (no edge graph to walk).

This is the meaning of the `trainEdgeId` field already present
in `State` (added by Phase 1A++): it's the inner state. The
outer state is `{mode, placeId, lineName, trainEdgeId: null}`.
The decoder will produce states with `trainEdgeId` populated
on train segments.

### Decoder shape

Two-layer Viterbi:

1. **Inner Viterbi** — one call per candidate train-segment
   `(t1, t2, L)`. Operates on the per-line subgraph of route
   edges. Returns:
     - `innerLogScore`: max-likelihood log-prob of the best
       edge sequence
     - `edgePath`: the actual sequence of edge IDs, one per
       minute in `[t1, t2]`
   Transitions: edge → edge that shares a node on L's subgraph
   (cost 0). Non-adjacent edges: blocked. Emission per minute:
   - GPS observed → Gaussian log-prob of perpendicular fix-to-
     edge distance, σ ~ 100 m for rail.
   - GPS null → log-prob of underground-emission for the edge
     (~0 for tunneled edges, large negative for surface edges
     where GPS would normally be observed).
   - Speed feasibility: edge dwell time should match physical
     train speed (≤ 70 km/h on Tube, ≤ 200 km/h on mainline).

2. **Outer HSMM Viterbi** — same shape as today's hsmmViterbi,
   but the per-segment emission score for `train @ L` segments
   is the inner-Viterbi `innerLogScore` instead of
   sum-of-per-minute-emissions. The duration prior, entry
   prior, transition prior all stay as-is. For non-train outer
   states, sum-of-emissions stays the same.

The two-layer split preserves the duration model. Inner edge
transitions within a train segment cost nothing (no duration
penalty per edge). Outer mode-segment closures pay the same
gamma duration cost as today. The "trains last ~30 min on
average" prior remains intact.

### Complexity

For each candidate `(t1, t2, L)`:
- Inner Viterbi: O(d × |edges_on_L|²) where d = t2 - t1
- For a per-day route graph with ~100 lines and ~50 edges per
  line in active bbox, |edges_on_L|² ≈ 2,500
- Per-segment inner cost: 2,500 × d ≈ 2,500 × 30 = 75K ops

For each outer HSMM Viterbi iteration:
- ~21 outer states (today's count)
- Candidate segment lengths d ∈ [1, D_max]; D_max ≈ 60 for train
- Per-minute outer cost: 21 × 60 × inner_cost ≈ 21 × 60 × 75K = 94M

Per day (T = 1440 minutes): 94M × 1440 = 135B ops. Too slow.

Memoise inner Viterbi by `(t1, t2, L, entry_edge_set,
exit_edge_set)`. Entry/exit edge sets are determined by the
prev/next observed GPS fixes — they change only when crossing
a GPS-present minute. For a typical day with ~50 train minutes
across the whole day, memoised inner calls reduce to O(50 × 30
× 11 lines) = 16K calls. Per-call ~75K ops = 1.2B ops/day —
still a lot but tractable with the per-(t1, t2) memoisation.

Real concern is that outer HSMM iterates over candidate `(t1,
t2)` pairs; need to integrate the inner call into the existing
Viterbi loop without re-computing from scratch. The
implementation will cache inner scores per `(t1, t2, L)` and
look them up during outer scoring.

### Persistence

`State.trainEdgeId` already exists. The decoded segments persisted
to `decoded_days` include the edge sequence as a JSON column on
train segments. `CLASSIFIER_VERSION → 5`.

### Subsumed factors

Both Phase 1A (`route-rail-evidence`) and Phase 1B
(`line-proximity-factor`) become unused on train states once the
inner Viterbi runs the same evidence directly on edge geometry
with a proper probabilistic emission. The intention is to retire
them in Phase 4 — keep them dormant during Phase 1 to allow A/B
comparison.

### Test strategy

The high-level acceptance test is at
`tests/route-aware-decoder-board-change.test.ts`. It constructs
a synthetic scenario that mirrors the 2026-05-22 board change:

- Synthetic route graph with two lines (`MetLine` and `JubLine`)
  sharing track Wembley → Finchley Rd → BakerSt, then Met
  continuing east (BakerSt → GtPortland → KX) and Jubilee
  continuing south (BakerSt → BondSt → GreenPark).
- Synthetic observation tensor: walking near Wembley → GPS-null
  train (10 min) → GPS-null train (10 min) → walking near
  GreenPark. No GPS at the boundary (entirely underground).
- The decoder MUST split the train run at the BakerSt boundary
  and attribute the first half to Met, the second half to
  Jubilee.

The test fails today (HSMM produces one Met or one Jubilee
segment). It must pass after the per-edge state space + inner
Viterbi land. This is the definition of "Phase 1 working."

Additional lower-level unit tests:

- Inner Viterbi correctness: given a known edge sequence,
  inner Viterbi recovers it from synthetic observations.
- Inner Viterbi connectivity: edges that aren't graph-connected
  on the line's subgraph cannot appear in adjacent positions
  of the recovered sequence.
- Inner Viterbi GPS-null underground emission: GPS-null minutes
  prefer tunnel edges; GPS-null minutes near surface rail incur
  penalty.

### Rollout plan

1. Write the high-level failing test (this commit).
2. Build inner Viterbi as a pure module. Unit-tested independently.
3. Wire inner Viterbi into the outer HSMM Viterbi via the
   per-segment emission score replacement. Keep the legacy
   per-minute factors active for safety; gate the new path
   behind a `USE_INNER_VITERBI=1` env var.
4. Run live eval. Confirm line score moves; confirm no mode/place
   regression.
5. Flip default to on. Bump CLASSIFIER_VERSION. Deploy.
6. Phase 4 cleanup: retire route-rail-evidence and
   line-proximity-factor.

Estimated effort: 1–2 weeks of focused work. Each step is
incrementally verifiable with the high-level test as the
end-state acceptance criterion.
