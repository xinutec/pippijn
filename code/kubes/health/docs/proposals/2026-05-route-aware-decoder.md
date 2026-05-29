---
created: 2026-05-29
updated: 2026-05-29
status: design
references:
  - ../design/probabilistic-principles.md
  - 2026-05-joint-sequence-model.md
  - 2026-05-hmm-learned-emissions.md
  - 2026-05-hsmm-physical-constraints.md
---

# Route-aware decoder — promoting state from `mode` to `(mode, route, position)`

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
- _next_ — review outcome, scope adjustments, decision to commit
  or further iterate.
