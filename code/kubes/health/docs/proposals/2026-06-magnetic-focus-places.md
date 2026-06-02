---
created: 2026-06-02
updated: 2026-06-02
status: design
references:
  - 2026-05-conflated-place-clusters.md
  - 2026-05-weighted-place-accumulation.md
  - 2026-05-physical-plausibility.md
---

# Magnetic focus_places — attribution as a stateful pull, not a per-segment pick

## Problem

`pickBestPlace` (`src/geo/place-prior.ts`) scores each stationary
segment's geometric centroid against every `focus_place` independently
using a Gaussian on distance + time-of-day match + visit-frequency
prior. Each segment is treated as an isolated observation; the answer
depends entirely on where that segment's noisy centroid happens to
land.

This works when one focus_place clearly dominates the area. It breaks
when a focus_place sits within GPS-noise distance of an unrelated OSM
POI:

- **2026-05-25 Varley vs Canada Gardens — Play Area.** The user spent
  92 minutes at Varley Apartments (a known focus_place, recurring
  partner visits). The day's GPS noise produced three alternating
  short stays (Canada Gardens / Varley / Canada Gardens), then the
  bridge-stays merger (`src/geo/bridge-stays-biometrics.ts`) combined
  them into one stay. The merged centroid landed slightly closer to
  the playground POI than to Varley's stored centroid; the playground
  is a typed leisure POI; the label landed on "Canada Gardens — Play
  Area" instead of "Varley (apartments)."

The focus_place was *there* — Varley wins on 05-20, on prior partner
visits, and on visit-frequency prior in general. On 05-25 it lost
because one day's noisy centroid drift happened to favour a
geometrically-close playground node — and that single-segment
geometric pick had no memory of the dozen prior Varley visits whose
centroid had already converged within ~10 m of the apartments.

The conflated-place-clusters work (shipped) addressed the analogous
*café + residence* case via time-of-day discrimination: the residence
and the café are visited at different hours, so even when spatially
fused they separate by when. **The Varley vs Canada Gardens case
isn't time-of-day separable** — the playground POI has no visit
profile of its own; the user simply doesn't go there.

## Principle

A place visited many times **anchors** the GPS readings near it. A
single visit's noisy GPS should be interpreted as drift *from* the
known centroid, not as new positional evidence to compete against it.
The user's mental model is right: "I'm at Varley" is a state that
persists across noisy fixes, broken only when actual movement evidence
says the user left.

This generalises the snap-to-stored-centroid step already in
`velocity.ts:660-680` (after a focus_place wins, the centroid is
snapped to the focus_place's stored coords for downstream lookups).
That step has the right *idea* but kicks in too late — only after the
geometric centroid has already been used to pick the winner. By the
time the snap runs, a weak winner has already been picked and the
runner-up has already lost.

The proposal here is to move the magnet *upstream* — let strong
focus_places bias the candidate-selection step itself.

## Relation to prior work

- **`2026-05-weighted-place-accumulation.md` (paused, fully
  reverted).** That proposal aimed to *improve* focus_place centroid
  accuracy through accuracy-weighting raw fixes. It burned on a
  reported-GPS-accuracy signal that lies and on `P(dwell | kind)`
  mining from a 10-min-censored stays table. The current proposal
  goes the other direction: **trust the existing median focus_place
  centroids** (which the paused proposal kept as the working baseline)
  and use them as anchors, not improve them. Hard constraint preserved:
  do not retry accuracy-weighting, do not retry dwell-from-focus_places
  mining.

- **`2026-05-conflated-place-clusters.md` (shipped Phase 1).** Adds
  time-of-day profiles to focus_places, splits clusters on time-of-day,
  uses time-of-day match in `pickBestPlace`, distance-aware type
  priority in `pickBestLandmark`. The time-of-day signal handles café +
  residence; the Varley vs Canada Gardens case is **not** time-of-day
  separable (the playground has no visit history at all). Magnetic
  anchoring is the missing piece for the no-time-signal case.

- **Task #173 (pending) — shop/* loses to amenity/* in
  `pickBestLandmark`.** Same class of bug (focus_place loses to a
  geometrically-close generic POI), narrower fix (a type-priority
  tweak). Magnetic focus_places is the more general fix; #173 becomes
  a special case of it.

## Design

### 1. Magnet strength on a focus_place

Each focus_place gets a derived **magnet strength** $M_p$ summarising
how confidently we believe the user is "at" $p$ when nearby. Computed
from existing focus_place columns; no new mining, no new schema:

$$
M_p = \log(1 + V_p) \cdot \sqrt{D_p / D_{\text{ref}}}
$$

- $V_p$ — visit count over the focus_place's history (already stored
  as the source of the visit-frequency prior).
- $D_p$ — total dwell at the place (existing `total_dwell_sec`).
- $D_{\text{ref}}$ — reference dwell scale (1 hour). Square-rooted so
  a 100-hour place is ~3× more magnetic than a 10-hour place, not 10×.

A focus_place visited twice for an hour each gets $M_p \approx 1.0$.
Home, with hundreds of hours of dwell over hundreds of visits, gets
$M_p \approx 30$. Varley with ~10 visits and ~30h dwell gets
$M_p \approx 12$. A one-off 10-min visit gets $M_p \approx 0.3$.

The shape is intentionally heavy-tailed: a regular place dominates a
one-off place by orders of magnitude.

### 2. Magnet pull in candidate generation

When scoring focus_place candidates for a segment, an additional
**proximity-magnet term** is added to the existing
`scorePlaceForSegment`:

$$
\log P_{\text{magnet}}(p) = M_p \cdot \mathbb{1}[d(p, c_{\text{segment}}) \le R_{\text{magnet}}(p)]
$$

where $R_{\text{magnet}}(p) = R_0 + k \cdot \sigma_p$, with $R_0 \approx
30$ m and $\sigma_p$ the focus_place's empirical visit-centroid scatter
(already stored or trivially computable from raw visits). $k \approx
2$ so most legitimate noisy visits fall inside.

In English: if the segment's centroid is within Varley's magnet
radius, Varley gets a log-score boost proportional to its magnet
strength. A strong focus_place comfortably outranks any same-distance
OSM POI; a weak one barely shifts the scoring.

This is **a soft prior**, not a hard veto. A focus_place whose
magnet pulls Varley into the lead can still lose to a much closer
focus_place at the same coords (e.g., the actual playground if it
ever becomes a focus_place after enough visits).

### 3. Anti-drift: magnetic detachment from sustained movement

The user's caveat — *we have to detach if we walk outside* — is the
critical guard. The magnet must not pull a moving user back to a
recently-visited place.

The detachment signal is **already in the data we collect**:

- Movement evidence: sustained walking-mode classification (≥3 min),
  GPS displacement > $R_{\text{magnet}}$, or step burst > 200 steps in
  5 min.
- The magnet only applies to **stationary segments** — moving
  segments are not candidates for focus_place attribution at all.
  This is a structural detachment, not a learned one: the segment
  classifier (already biometric-aware) decides "moving" first, and
  once moving the magnet is silent.

The previous-stay history doesn't extend the magnet across a moving
segment. If the user walks from Varley to the playground for 10
minutes and then stops, the new stationary segment is scored fresh —
no carry-over from "we were at Varley." This is the right behaviour:
once the user actually leaves, the system has no business pulling
them back.

### 4. What this does NOT do

- **No per-fix magnetic pull on raw GPS coordinates.** The magnet
  biases the candidate-scoring step only. Raw fixes are still
  recorded as-observed; the segment centroid is still the geometric
  mean of its fixes. This avoids the "rewrite history" problem and
  keeps debugging straightforward — what you see in raw data is what
  was actually observed.

- **No persistent "currently inside place X" state across days.**
  Each day is decoded fresh; magnetism is per-segment from the
  stable focus_places snapshot. This dodges the "incremental
  accumulator" trap the paused proposal warned about: rebuild-from-
  raw-data must remain reproducible.

- **No mining of new focus_place features.** Magnet strength is
  derived from columns we already store. No dwell-by-kind histograms,
  no accuracy-weighted centroids — the failure modes of the paused
  proposal stay out of reach.

- **No special treatment of named focus_places vs unnamed ones.**
  A "frequent unnamed" focus_place can be magnetic too; the magnet
  is about whether we know there's *a* recurring place here, not
  about whether we know its name.

## Worked example — 05-25 Varley vs Canada Gardens

Today's pickBestPlace scores roughly:

- Varley: $-\log(2\pi\sigma^2)/2 - d^2/(2\sigma^2) + \log P_{\text{freq}}(\text{Varley})$
  ≈ moderate negative + small positive frequency boost.
- Canada Gardens — Play Area: an OSM POI candidate via `bestPlace`,
  not a focus_place; the playground wins the OSM-amenity vote and the
  geometric distance is slightly shorter.

Net: the playground's geometric proximity edges out Varley's frequency
prior — the prior is bounded so it doesn't dominate distance evidence,
which is the right design (a 2-km-away matching profile must not beat
the place the user is standing in).

With magnetism, Varley's $M_p \approx 12$ (recurring partner visits)
adds a +12 log-score boost when the centroid is within Varley's magnet
radius. Even if Varley's centroid is 50 m from the segment centroid
vs the playground at 30 m, the magnet boost more than compensates —
Varley wins, label is "Varley (apartments)", snap-to-stored-centroid
keeps the downstream OSM lookup at the known building, not in the
park.

If on a future day the user actually visits the playground briefly
(no recurring history yet, $M_{\text{playground}} = 0$), the magnet
contributes nothing for the playground and the geometric-distance
term picks correctly.

## Phasing

- **Phase 1 — magnet strength + scoring boost.** Add $M_p$ as a
  computed property of each focus_place in
  `scorePlaceForSegment`. Add the proximity-magnet term to the
  existing scoring. Calibrate $R_0$ and $k$ against the captured
  05-25 fixture; pin no-regression on the goldens. Behind a feature
  flag (`useMagneticAnchoring`) for the first release so the goldens
  can compare both paths.

- **Phase 2 — magnet visualisation in the dev UI.** When a segment
  has competing nearby focus_places, surface the magnet scores in
  the analyze-day output so the human can audit which focus_places
  were pulling.

- **Phase 3 (deferred) — magnet on *unmined* recurring locations.**
  A location the user has visited many times but which the
  focus_places mining hasn't captured yet (e.g., new hospital
  admission) could still be anchored if the system learns it
  in-day. Out of scope here.

## Testing

- **Real-data fixture, 2026-05-25.** Capture the 10:53–12:25
  Varley window (already in prod data; gitignored fixture). Assert
  the pre-magnet pipeline labels it "Canada Gardens — Play Area"
  and the post-magnet pipeline labels it "Varley (apartments)."
  This is the canonical test case per the project's real-data-
  fixture rule.

- **Goldens.** Re-run after enabling the flag. Expect: 05-20
  unchanged (Varley already wins), 05-22 unchanged (no Varley-class
  ambiguity), 04-29 and 04-30 unchanged (sparse days), 05-15 and
  05-18 unchanged (NHNN/Work clear). Any unexpected drift on the
  blessed days needs cross-check against the GT narratives.

- **No-regression unit tests for `scorePlaceForSegment`.** A new
  test: two candidates, one a strong focus_place (high $M_p$,
  modest distance), one a weak focus_place (low $M_p$, slightly
  closer distance). The strong magnet must win. A counterpoint:
  the same strong focus_place 1 km away must NOT win against a
  close competitor — the magnet is range-gated to
  $R_{\text{magnet}}$.

- **Detachment.** A two-stay scenario test: stay at Varley, walk 3
  min away, stay at a coffee shop near the playground. The second
  stay must NOT be pulled to Varley.

## Risks

- **Over-anchoring to Home.** Home has the largest $M_p$ by far. A
  segment whose centroid happens to drift within Home's magnet
  radius (because the user is walking past) could be wrongly
  attributed to Home. Mitigation: the structural detachment in
  Design §3 — only stationary segments are eligible. A walking
  segment isn't pulled.

- **Anchoring to a stale focus_place after the user moves house.**
  When a focus_place ceases to be visited, its $M_p$ stays high
  until the 365-day window rolls past it. Mitigation: $M_p$ scales
  with *recent* visit count, not all-time. Implementation detail
  for Phase 1.

- **Test-fixture drift.** The 05-25 fixture must capture enough of
  Varley's prior visit history for the focus_places mining to
  produce a representative $M_p$. The fixture rebuild step needs
  to include the focus_places snapshot from the day of capture,
  not just the GPS for that one day.

## Why this is worth the design effort

The Varley case is a single example, but the class is broad: every
focus_place that sits within GPS-noise distance of a typed OSM POI
is at risk of being misattributed on any noisy-GPS day. As the user
accumulates recurring places (Dasha's home, regular cafés, gyms,
medical providers), the count of at-risk pairings grows. The magnet
is one principle covering all of them; once shipped, every
focus_place gets the benefit automatically.

It also closes the loop on the user's mental model: "I've been here
many times, my GPS noise should not make me look like I'm somewhere
else." That maps directly onto $M_p$ as the formal statement.
