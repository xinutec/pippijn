---
status: active
created: 2026-05-18
updated: 2026-05-18
---

# Proposal — rail-snap: draw train journeys on the rail track

## Problem

On the Map tab a train journey renders as a wild zigzag. Underground
and in cuttings the phone falls back to cell-tower positioning, so the
fixes scatter hundreds of metres to a kilometre off the track. The map
draws the raw fixes, so a clean rail ride looks like noise.

The goal: when a segment is confidently a train run on a known line,
draw the journey *on the actual rail track* instead of the zigzag.

## First attempt — per-fix map-matching (reverted)

The first attempt shipped over three deploys and was **fully reverted**
(revert commit `7d0fd32`). Its approach:

1. Identify the line (from the segment's `wayName`, e.g.
   `<board> → <alight> · <line>`, or mine it from OSM at the
   endpoints).
2. Fetch the line's OSM geometry, stitch the `way` segments into a
   route polyline.
3. Project each raw GPS fix onto the nearest point of the route
   (`projectOntoPolyline`), enforce monotonic progress, densify with
   the route's own vertices.

### Why it failed

Per-fix map-matching needs the fixes to *trace the journey*. Real
train-run GPS does not — it has three pathologies, and each defeats a
different route-fit metric:

- **Dwell-clumps.** A multi-minute platform wait emits dozens of
  near-identical fixes at one spot. A *median* route-fit is then
  dominated by that clump: a short stub of track next to the platform
  scores a near-zero median offset and "wins", even though it ignores
  every fix actually on the journey.
- **Fixes that lie about their accuracy.** Some fixes report a small
  accuracy radius (sub-100 m) but sit ~1 km off the track. A *p90*
  route-fit, robust to the dwell-clump, is in turn blown up by a
  handful of these — every candidate route scores badly.
- **Coarse cell-tower scatter.** The mid-journey fixes sit ~900 m off.
  A *mean* is dominated by them.

No single percentile is robust to all three at once. The visible
end-state was a snapped path collapsed to a ~40 m blob at one station,
so the map drew a straight line clear across the journey — worse than
the honest zigzag.

The deeper lesson: **the fixes cannot drive the geometry.** They are
reliable enough to confirm *which line* a run is on, and nothing more.

## What was kept from the first attempt

- **`osm_way_routes` table + migration v37.** A rail line in OSM is a
  `relation[route]`, and its track ways frequently carry the line name
  only on the relation, not the way. Mirroring way → route-relation
  membership lets a line's *complete* geometry be assembled. This part
  was sound. The migration entry is retained (the migration runner
  keys by array index — removing it would corrupt the index); the
  table is currently an inert orphan after the revert.
- **`capture-railsnap-fixture.ts`** — see Testing strategy below.

Not yet done: a follow-up to keep `osm_way_routes` *filling* — fetch
route relations alongside the existing `railway` OSM coverage so the
mirror tracks travelled areas without a backfill job.

## Proposed approach — station-anchored

Stop using fix positions for geometry. For a confident train segment
we already know four things, all reliable:

- the **line**,
- the **boarding station** and **alighting station** (the segment's
  `wayName` is `<board> → <alight>`),
- the **start and end times**.

Draw the OSM route *between the two stations* along the identified
line, and interpolate time across it. The fixes are used only to
confirm the line and, where the line forks, pick the branch — they
never drive the drawn geometry.

This is robust to all three pathologies, because dwell-clumps, lying
accuracy, and coarse scatter can only corrupt fix *positions*, and fix
positions are no longer load-bearing.

Open sub-problems for the implementation:

- Resolve the two station positions (OSM `railway=station` points by
  name; the segment names them).
- Assemble the line's geometry between the stations from `osm_lines` +
  `osm_way_routes`, and extract the sub-route between the two station
  projections.
- Handle a journey that genuinely changes line (two-line trips): no
  single track spans it — either split the segment at the interchange,
  or leave it un-snapped.

## Testing strategy — the real lesson

The first attempt's unit tests passed the entire time it was broken.
They ran on synthetic routes with fixes spread evenly along them, so a
dwell-clump never outweighed a journey and no fix ever lied. "Tests
pass" carried no information about whether the feature worked.

The fix is a real-data end-to-end test:

- **`capture-railsnap-fixture.ts`** freezes one real day into a
  self-contained fixture — raw fixes (with accuracy), classified
  segments, and the OSM rail geometry (lines, route memberships,
  stations) of every train corridor. No DB or network needed to
  replay it. Fixtures live in `tests/fixtures/railsnap/` — gitignored,
  same policy as `tests/fixtures/days/` and `tests/golden/` (real
  coordinates and journeys stay local).
- **`tests/railsnap-e2e.test.ts`** (to be written): `skipIf` the
  fixture is absent, so CI without it simply skips; locally it runs on
  every `npm test`. It builds the OSM lookups from the fixture, runs
  the algorithm on each real train segment, and asserts properties the
  synthetic tests structurally could not: the snapped path spans the
  journey (catches the degenerate blob), stays within a sane offset of
  the rail line, is monotonic, and starts/ends near the two stations.

Synthetic unit tests stay — for the pure geometry helpers — but the
E2E fixture test is the verdict on whether the feature works.

## Concrete next steps

1. Write `tests/railsnap-e2e.test.ts` against the captured fixture
   (assertions first — TDD).
2. Implement the station-anchored algorithm.
3. Re-introduce `osm_way_routes` *population* (route fetch piggybacked
   on `railway` coverage) so the mirror keeps filling.
4. Frontend: re-add the snapped-path render layer, visibly distinct
   (dashed) so it reads as inferred, not measured.

## Key references

- Revert commit: `7d0fd32`. Capture tool: `7863198`
  (`src/cli/capture-railsnap-fixture.ts`).
- `osm_way_routes` migration: `schema.ts`, migration index 48 (v37).
- Diagnostic approach used during the investigation: a CLI that ran
  the pipeline for a day and traced each train segment stage by stage
  (line resolution → geometry fetch → stitch → fit). Reverted with the
  rest, but the pattern — trace every stage on real data — is what a
  redesign should keep.
