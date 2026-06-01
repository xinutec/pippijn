---
created: 2026-05-31
updated: 2026-06-01
status: design
references:
  - ../design/probabilistic-principles.md
  - 2026-05-physical-plausibility.md
  - 2026-05-route-aware-decoder.md
  - 2026-05-joint-sequence-model.md
  - 2026-05-hsmm-physical-constraints.md
  - 2026-06-tube-journey-segment.md
---

# Constraint-first decoder — generator + scorer split

> **Companion proposal**:
> [`2026-06-tube-journey-segment.md`](./2026-06-tube-journey-segment.md)
> adds a post-decode composition layer on top of this decoder. The
> per-minute classification this proposal builds stays unchanged;
> the tube-journey proposal wraps consecutive train + intra-
> station-walk + platform-wait minutes into a single segment-
> level "tube journey" event for UI + eval purposes. The decoder
> here is honest about every minute's physical mode; the wrapper
> there says how the timeline aggregates those minutes into the
> events a human narrates.

## Why this proposal supersedes the per-minute factor stack

The decoder has accumulated a per-minute factor library — speed
Gaussian, HR / cadence emission, OSM distance projection,
geometric-feasibility teleport veto, rail-corridor presence,
line-proximity, route-rail-evidence with connectivity check, and
the inner edge-Viterbi for train-on-line scoring. Each was added
to push the joint posterior toward physically sensible
classifications. Each individually was correct. The accumulated
result, evaluated on the four blessed days (2026-04-30, 05-18,
05-20, 05-22):

| | mode | place | line |
|---|---|---|---|
| HSMM with all per-minute factors | 7481/7852 (95.3%) | 4079/4169 (97.8%) | 0/6 (0%) |
| Route-aware decoder (Phase 1, hierarchical Viterbi) | 1705/1746 (97.7%) on 05-22 | 100% | 0/6 |

Line score has been stuck at 0/6 across every per-minute
addition. The per-minute hierarchical-Viterbi route-aware decoder
*regressed* mode by 0.6 pp on 05-22.

The diagnosis is structural, not parameter-tuning: **the decoder
enumerates the cartesian product of `(mode, place, line)` over T
minutes and scores it with per-minute factors. Most of that
hypothesis space is physically impossible** — a train segment
that doesn't start at a station, a walking segment of 60 km/h, a
sleep label at a hospital the user left two hours before
midnight, a Met-line ride to Green Park (no Met station at Green
Park), a 30-minute teleport between adjacent same-place
stationary segments. Per-minute factors penalise these softly,
but the search space is so much larger than the valid subspace
that soft penalties don't reliably win.

The correct architecture is a generator/scorer split:

1. **Generator: produce only physically possible state sequences.**
   Hard constraints filter the hypothesis space upstream of any
   scoring. A `train @ Met` segment is not a candidate unless it
   has a valid `(board_station, alight_station)` pair on Met,
   connected on Met's edge subgraph, with the GPS-context at
   board and alight consistent with station-dwell. Mode
   transitions occur only at physically meaningful boundaries
   (station, road junction, walkable handoff).
2. **Scorer: pick the best survivor with the per-minute factor
   library.** What the HSMM does today, just over a much smaller
   candidate space.

The per-minute factors don't go away — they decide between
physically-equivalent options (Victoria vs Piccadilly through
the same central-London tunnels, café vs residence at a
co-located cluster, the alight station when several plausible
ones exist). They're the right tool for tie-breaking inside the
valid set, not for filtering the invalid set out of it. That's
the structural mistake the per-minute factor stack has been
making.

## What "physically possible" means concretely

Five hard constraints carry most of the weight. Each is a
deterministic property of the day's geometry + the route graph,
independent of any soft prior:

### C1 — Train segments must be valid (board, line, alight) triples

A `train @ L` segment with start time t₁ and end time t₂ is a
candidate iff:

- The GPS context at t₁ (the most recent fix on or before t₁) is
  within R_station ≈ 200 m of a station node N₁ on line L.
- The GPS context at t₂ (the next fix on or after t₂) is within
  R_station of a station node N₂ on line L.
- N₁ and N₂ are graph-connected on L's per-line edge subgraph.
- N₁ ≠ N₂ (a one-station ride is degenerate; the user just walked
  through the station).

Today the decoder freely hypothesises e.g. `train @ Met` from
Wembley to Green Park — Met has no Green Park station, so the
triple is invalid, but nothing in the decoder rules it out
structurally. The per-minute geometry tries (an inner-Viterbi
exit-edge filter sometimes catches it), but the structural
answer is: it's not a candidate.

### C2 — Walking segments must be physically walkable

A `walking` segment from minute t₁ to t₂ covering the GPS path
between two fixes is a candidate iff:

- Peak GPS speed in the segment is ≤ V_walk_max ≈ 12 km/h. (A
  "walking" segment with motorised peak speed is not walking;
  task #176.)
- Total path distance ÷ (t₂ − t₁) is ≤ V_walk_avg_max ≈ 7 km/h.
  Average outside this is implausible at human cadence.

A "walking" segment whose GPS implies sub-walking-pace or
super-walking-pace is rejected as a candidate. The pipeline
emits `unknown` instead (already a state class).

### C3 — Stationary segments must be place-coherent

A `stationary @ P` segment is a candidate iff all observed GPS
fixes within the segment are within R_place ≈ 80 m of P's
centroid. Otherwise the user is not at P; classify as
`stationary @ none` or a different place.

A `stationary @ none` segment is a candidate iff observed GPS
fixes within the segment all sit within ~100 m of each other —
otherwise the user is moving and should be a moving-mode
segment, not stationary.

### C4 — Cross-segment continuity: adjacent segments share a node

Adjacent segments must connect at a physical point:

- `train @ L` ending at alight station A followed by `walking`:
  the walking segment must start within R_station of A.
- `walking` followed by `train @ L` at board station B: the
  walking segment must end within R_station of B.
- `stationary @ P` followed by anything: the next segment must
  start within R_place of P.
- `train @ L₁` ending at A followed by `train @ L₂` starting at
  A: A must be a station serving both L₁ and L₂. (Task #175 —
  back-to-back train legs must share a station — already
  partially in the pipeline.)

A candidate sequence with a teleport between segments is not a
candidate. The decoder doesn't soft-penalise teleports; it
doesn't consider them at all.

### C5 — Sleep-window coherence

When `sleep_stages` indicates the user is asleep, the mode is
`stationary` (already enforced as a hard transition factor in
the HSMM). When the sleep window starts at minute t and the last
GPS fix before t is at coordinate G, the sleep-place candidates
are restricted to lodgings/residences/hospitals within R_place
of G — never a fabricated address far from G. Today's pipeline
*mostly* gets this right (post-midnight-place was a fix to this
class) but the constraint isn't articulated as a generator rule.

## What changes about the existing factor library

| Factor | Today | After generator/scorer split |
|---|---|---|
| route-rail-evidence | per-minute boost when bookend GPS shows underground L | retire — train-segment validity (C1) subsumes |
| line-proximity-factor | per-minute Gaussian distance from GPS to L's edges | retire — same |
| route-aware-decoder Phase 1 (inner Viterbi) | per-segment edge-Viterbi for train@L | retire — generator emits the alight/board pair directly; inner-Viterbi can return for rendering the *visual* track path but not for line attribution |
| geometric-feasibility | per-minute teleport-speed penalty for stat @ place | retire — C3 + C4 enforce stronger structural form |
| speed-Gaussian per mode | per-minute mode emission | KEEP — scorer evidence between valid candidates |
| HR Gaussian per mode | per-minute biometric emission | KEEP — scorer evidence |
| cadence emission | per-minute biometric emission | KEEP — scorer evidence |
| osm-distance for stat @ place | place-distance Gaussian | KEEP — scorer evidence |
| HSMM duration prior | per-segment-duration gamma | KEEP — scorer evidence |
| Entry prior (hour-of-day, visit frequency) | per-segment-entry | KEEP — scorer evidence |
| Transition prior | per-(prev→next) | partly retire — C4 hard-zeros most invalid transitions; the soft remainder is mode-mode transition rates |

Net: the factor library *shrinks*. The five-or-so per-minute
factors that were trying to enforce structural constraints
collapse into five hard generator constraints. What remains are
the genuine scoring signals (HR, speed, place-distance, duration,
hour-of-day).

## Implementation phasing

Each phase ships and is independently evaluable on the five
blessed days.

### Phase 1 — Train (board, line, alight) generator (C1)

The narrowest path to the line score improving. Concretely:

1. Mine `station_lines[station_node_id] = {line names}` from the
   route graph (Phase 0 already builds the route graph; this is
   a derived index over its station-tagged nodes).
2. Build `enumerate_train_candidates(observations, route_graph)`:
   for each maximal run of GPS minutes consistent with train
   speed (≥ 12 km/h average, peak ≥ 25 km/h), enumerate the
   valid (board, alight, line) triples by:
   - Look up stations within R_station of the GPS at the run's
     start and end.
   - For each station-pair (B, A) and each line L such that
     {B, A} ⊆ station_lines and B, A are graph-connected on L:
     emit a candidate `train @ L from B to A spanning [t₁, t₂]`.
3. Wire into the outer HSMM as a hard filter on `train @ L`
   segments. The HSMM scores only candidates the generator
   produced; everything else has score -∞.

Failing acceptance test (real data): on 2026-05-22, the
generator emits exactly one valid (Met, Wembley Park, Baker
Street) candidate for the 13:16-13:32 ride, exactly one valid
(Jubilee, Baker Street, Green Park) for 13:26-13:35, and exactly
one valid (Met, Pentonville Road area, Finchley Road) for
20:05-20:15 (with KX as the boarding station). The decoder
picks the line correctly for every train minute of every
ground-truth train segment in the file.

Expected eval impact: line score 0/6 → 5/6 or 6/6 on the
existing scorable minutes (Victoria vs Piccadilly at 15:30-15:38
remains soft-ambiguous since both station-pairs are valid).

Estimated effort: ~1 week. The route graph already has nodes +
line memberships; this is a derived index + an enumeration loop +
filter wiring.

### Open friction — labelling convention vs per-minute honesty

The mode-class lock + per-minute decoder produce a *physically
honest* answer at every minute: cadence > 0 stays foot, cluster-
tight GPS with no cadence stays stationary, fast-displacement
stays vehicle. When the user walks 2-3 minutes between Tube
platforms during an interchange, the lock correctly says foot
and the decoder correctly says walking. The ground-truth tables
+ existing pipeline (task #165, interchange absorber) absorb
that walk into the surrounding train segments under a labelling
convention. The eval then scores the decoder's honest walking
minutes as mode-mismatches against the convention-train labels.

Resolving this *inside* the per-minute decoder would require
either lying about cadence-confirmed walking minutes (no) or a
fragile post-decode adjustment that knows which walking minutes
to absorb where. The cleaner resolution is the tube-journey
wrapper proposed in
[`2026-06-tube-journey-segment.md`](./2026-06-tube-journey-segment.md)
— a composition layer above the per-minute decoder that groups
consecutive train + intra-station-walk + platform-wait minutes
into one *tube journey* segment. The per-minute physics stay
honest (every minute keeps its mode), the eval and UI work at
the journey level (matching the convention + the human
narrative), and the daily step count still correctly attributes
the intra-station walk to walking.

### Phase 1.5 — Mode-class lock (universal physical facts)

Shipped 2026-05-31 (`src/hmm/mode-class-lock.ts`). Per-minute
"lock" derived from sustained signal over a 5-minute window using
universal human-physiology + GPS-noise constants — not
user-specific tuning, not learned, not configurable per-user:

| Lock | Condition | Implication |
|---|---|---|
| `foot` | ≥ 3 of 5 window minutes have cadence ≥ 30 spm | Walking-class; not vehicle, not stationary |
| `vehicle` | GPS-window displacement (or per-minute prev/next bookend) implies > 12 km/h AND no sustained cadence | Vehicle-class; not walking, not stationary |
| `stationary` | GPS cluster ≤ 80 m AND no sustained cadence AND some cadence signal exists | Stationary; not walking, not vehicle |
| `null` | none of the above triggered | Silent; scorer decides |

Wired into the route-aware decoder's `segmentEmission` as a hard
rejection: a segment whose mode is incompatible with the lock at
any minute it covers scores -∞. This is the universal physical-
fact filter the other phases (train generator, walking veto,
continuity, sleep-window) layer on top of. The lock alone
eliminates large swaths of the per-minute hypothesis space
without any user-specific knowledge.

Eval outcome on 2026-05-22 (1 day): line score 0/6 → 6/8 (75%),
mode 97.7% → 98.2% (over the no-lock route-aware baseline). The
Victoria Line ride 15:30-15:38 flipped from L:mismatch to
L:match.

Why this works structurally: the lock encodes what the user MUST
be doing in three of the four physically-decidable cases (foot
motion / vehicle motion / true stationarity). The remaining
ambiguous minutes (sparse data, transitions, edge cases) are
where the scorer's per-minute factor library has discriminative
power. The previous architecture asked the scorer to solve all
four cases at once and routinely lost on the easy three.

### Phase 2 — Walking veto + stationary coherence (C2 + C3)

Track #176 (walking veto for motorised peak speed). Also extend
to the avg-speed + spatial-coherence checks for stationary
segments. Both are deterministic — peak/avg speed and pairwise
fix distance over the segment.

Failing acceptance test: on a captured day where the pipeline
labels a brief taxi ride as walking (e.g. the 2026-05-22
20:31-20:46 segment from Finchley Road to Royal Free), the
generator's candidate set excludes walking. The decoder picks
driving instead.

Estimated effort: ~3 days.

### Phase 3 — Cross-segment continuity (C4)

The big one. Generator-level constraint that adjacent segments
share a physical endpoint. Implemented as a transition filter on
the outer HSMM: when extending a segment ending at node N to a
new segment, the new segment must start at N (within R_station
or R_place). Today's HSMM transition matrix is per-state; this
generalises to per-(state, endpoint-node).

Failing acceptance test: on 2026-05-22, no decoded sequence
includes a "train from Wembley → Green Park" followed by a
"walking near Cleveland Clinic" without an intervening alight at
Green Park. The continuity constraint forces the segment chain
to physically connect.

Estimated effort: ~1-2 weeks. The HSMM Viterbi needs to track
endpoint context as part of its state — augmentation similar to
the duration trellis.

### Phase 4 — Sleep-window coherence as generator rule (C5)

Restrict sleep-window place candidates to lodging/residence
POIs within R_place of the user's last pre-sleep GPS fix.
Today's pipeline gets most of this right but not articulated as
a generator constraint. Codifies the post-midnight-place +
next-day fallback logic into the generator.

Estimated effort: ~3 days.

### Phase 5 — Retire the superseded per-minute factors

Once Phases 1-4 are in prod and the eval is stable, retire:

- `src/hmm/route-rail-evidence.ts` (subsumed by C1)
- `src/hmm/line-proximity-factor.ts` (subsumed by C1)
- `src/hmm/inner-viterbi-edges.ts` (kept only for rendering, not
  scoring)
- `src/hmm/route-aware-decoder.ts` (Phase 1 hierarchical Viterbi
  approach abandoned in favour of generator/scorer)
- Most of `geometric-feasibility.ts` (subsumed by C3 + C4)

Each retirement is preceded by an eval-no-regression check.
`CLASSIFIER_VERSION` bump and a full re-decode of cached days.

Estimated effort: ~3 days.

## Test discipline

Every phase lands with a real-data failing acceptance test under
`tests/scenarios/` or `tests/<feature>/`. The test references a
captured day fixture (gitignored, locally captured via
`capture-day` / `capture-route-graph-fixture`) and asserts the
generator's candidate set or the decoder's output against the
ground-truth narrative in `tests/golden/ground-truth/`. The
phase is "done" when the failing test goes green and no
previously-passing test regresses.

Synthetic unit tests for the generator components (e.g.
"enumerate-train-candidates correctly rejects a Met-line ride to
Green Park") are required but insufficient on their own. The
real-data fixture is the contract.

## Decision

Recommend committing. The five phases close the structural
ceiling that the per-minute factor stack has hit. Each phase is
incremental, each leaves the system shippable, and the test
discipline keeps the eval honest. The line-score regression
from 0/6 (per-minute factors) to whatever-the-generator-produces
is the immediate measurable win.

## Decision log

- 2026-05-31 — proposal drafted, status `design`. Anchors the
  architecture for all future classification work; the
  per-minute factor library is now in maintenance mode pending
  Phase 5 retirement.
