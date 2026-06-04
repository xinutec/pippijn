---
created: 2026-06-04
updated: 2026-06-04
status: design
references:
  - 2026-05-scored-classification.md
  - 2026-06-presence-continuity.md
  - 2026-05-joint-sequence-model.md
---

# Deterministic fixtures for the classification pipeline

## Problem

`computeVelocity` and `decodeAndPersist` are pure functions in their
intent but impure in their dependencies. Each reads from mutable
external state at call time:

- **PhoneTrack/Nextcloud HTTP** — raw GPS fix range fetches
- **`heart_rate_intraday`, `sleep_stages`, `steps_intraday`** —
  Fitbit biometrics, ingested continuously
- **`mode_biometrics`** — per-user mining output, refreshed weekly
- **`focus_places`** — visit-frequency mining output, refreshed
  weekly; `visit_weight` and `hour_profile` shift with every refresh
- **`osm_lines`, `osm_points`, `osm_cache`, `osm_coverage`** — OSM
  mirror, refilled on cache misses
- **`rail_route_cache`** — rail geometry mining output, refreshed
  nightly
- **`decoded_days`** — HSMM output, written by every decode-day run
- **`presence_log`** — cross-day continuity rollup, written by every
  refresh-presence-log run

The golden harness (`tests/golden/`) compares live `computeVelocity`
output against a frozen `expected/<date>-<user>.json` baseline. Every
one of the eight bullets above is a silent drift channel: change any
of them between bless time and check time and the diff surfaces as
"golden regression" with no way to attribute the change to a specific
input.

The regression seen on 2026-06-03 is the canonical example:
re-running `decode-day` for 2026-04-29 / 04-30 / 05-20 / 05-22 during
an unrelated A/B test rewrote `decoded_days` with HEAD code. The
goldens, blessed earlier the same day, then diffed against a
different `decoded_days` row than the bless had captured. The
"continuity flag broke 4 goldens" conclusion was wrong — none of the
flag's code paths fired (flag was off, guard short-circuited). The
goldens broke because `decoded_days[04-30]` changed under them, and
they had no way to see that.

This shape recurs every time a non-input mutates: weekly mining, the
nightly cron, a teammate running `decode-day` locally, the user
re-syncing PhoneTrack. The current test surface cannot distinguish
"my code change broke this" from "the world changed under the
baseline".

## Principle

Tests are reproducible by construction. The pipeline's behaviour on a
given input must be a deterministic function of that input — no
"and whatever the DB happens to hold today". To enforce this, the
pipeline boundary becomes explicit: every external read is plumbed
through a single `ClassificationInputs` value, and the pipeline never
reads from a DB or a network. Production wraps the pipeline with a
DB-loader; tests wrap it with a fixture-loader. Same pipeline, two
sources.

A captured fixture is the **closure** of one day's classifier inputs:
every byte the pipeline needs to produce its output, with no DB
fallthrough. Re-running the pipeline against the fixture is a pure
function call. Re-blessing is an explicit code review of the diff,
not a side effect of running anything.

## Design

### The input boundary

Introduce `ClassificationInputs`:

```ts
interface ClassificationInputs {
  // Identity
  userId: UserId;
  date: string;           // YYYY-MM-DD, local
  displayTz: string;      // IANA timezone

  // PhoneTrack fixes for three contextual windows. Same shape the
  // current pipeline pulls — three fetches off one openPhoneTrack
  // session.
  phonetrack: {
    today: TrackFix[];           // full local day
    morning: TrackFix[];         // next-day midnight → next-day morning
    priorEvening: TrackFix[];    // prior-day evening
  };

  // Biometrics — Fitbit series clipped to the day's UTC window.
  biometrics: {
    hr: HrSample[];
    sleepStages: SleepStageSample[];
    steps: StepSample[];
    modeBiometrics: ModeBiometricsRow[];   // per-user, all rows
  };

  // Place / line snapshots — the relevant rows only.
  focusPlaces: FocusPlaceRow[];            // all user rows
  presenceLogPriorDay: PresenceLogRow | null;
  osm: {
    lines: OsmLineRow[];                   // spatial bbox of the day
    points: OsmPointRow[];                 // spatial bbox of the day
    coverage: OsmCoverageRow[];            // any tile flagged covered
  };
  railRoutes: RailRouteCacheRow[];         // routes used by the day's runs

  // Optional HSMM override — when testing the HSMM decode in isolation
  // we skip this; for the velocity-layer golden we supply the HSMM
  // output that velocity reads via loadDecode().
  hsmmDecode: DecodedSegment[] | null;
}
```

The shape mirrors what the pipeline reads from the DB today. No new
fields, no anonymisation pass. The whole point is that this is the
exact closure of inputs.

### The function refactor

```ts
// before:
async function computeVelocity(
  config: Config,
  userId: string,
  date: string,
  tz: string,
): Promise<VelocityResult> { ... }

// after:
async function computeVelocity(
  inputs: ClassificationInputs,
): Promise<VelocityResult> { ... }

// production loader (does what the current function does at the
// boundary, called by /api/velocity, decode-day, capture-day):
async function loadClassificationInputs(
  config: Config,
  userId: string,
  date: string,
  tz: string,
): Promise<ClassificationInputs> { ... }
```

`computeVelocity` becomes pure-in-inputs. No `selectFrom`, no
`openPhoneTrack`, no `loadDecode`. All of those move to
`loadClassificationInputs`.

Same refactor for `decodeAndPersist` (decode-day): split into
`loadHsmmInputs(...)` and `decodeHsmm(inputs): HmmResult`.

### The fixture format

Each golden day becomes one file:

```
tests/golden/days/<date>-<user>.json
```

with shape:

```ts
interface CapturedDay {
  meta: {
    fixtureFormatVersion: number;       // bump on schema change
    capturedAt: string;                 // ISO
    capturedAtCodeSha: string;          // git rev at capture
    description: string;                // from manifest
  };
  inputs: ClassificationInputs;         // the closure
  expected: {
    velocity: NormalizedState[];        // what golden-check compares
    decode: DecodedSegment[] | null;    // HSMM-isolated comparison
  };
  groundTruth: GroundTruth | null;      // hand-edited; never overwritten by --bless
}
```

`tests/golden/days/` is gitignored (same private-data rationale as
the current setup). The whole file is the unit of versioning — the
manifest is replaced by the union of files under `days/`.

### The harness

```
golden-check-v2.js                 # reads tests/golden/days/*.json
  for each fixture:
    inputs = fixture.inputs
    actual = computeVelocity(inputs)
    if actual != fixture.expected.velocity:
      print diff
      exit 1

golden-check-v2.js --bless         # for each fixture: update expected.velocity = actual
golden-check-v2.js --bless DATE    # one day

capture-day-v2.js DATE USER TZ     # connects to prod DB, dumps a fresh fixture
  inputs = loadClassificationInputs(config, user, date, tz)
  actual = computeVelocity(inputs)
  write tests/golden/days/<date>-<user>.json with inputs + expected + groundTruth: null

recapture-day-v2.js DATE USER      # re-pulls inputs, keeps groundTruth, requires --bless to update expected
```

`--bless` updates `expected.velocity` from the current pipeline run
against the **already-captured** inputs. It does not re-pull inputs.
This is the key inversion: blessing edits the expected side of the
file, never the inputs side. To refresh inputs from prod you must run
`capture-day-v2` (overwrites inputs + clears expected) or
`recapture-day-v2` (overwrites inputs, keeps expected, requires
explicit bless on the diff).

### Why this is the right boundary

- **Refactor cost is bounded.** Two functions move: `computeVelocity`
  and `decodeAndPersist`. The boundary already exists informally —
  every external read is in the first 50 lines of each function.
- **No prod behaviour change.** Production routes still call
  `loadClassificationInputs(config, ...)` then `computeVelocity(...)`.
  Same DB queries, same wire calls, same output.
- **Tests don't touch a DB.** No port-forward, no mock pool, no
  parity worries. `npm run golden-v2` runs against files only.
- **Code SHA recorded.** When a fixture was captured against commit
  `abc123` and current code differs, the test reports
  `captured_at_code_sha != current_sha` as part of the diff context.
  Doesn't fail — just informs.
- **Mining as input.** `focus_places` (with its `visit_weight` and
  `hour_profile`) is just another field on the fixture. A new mining
  cycle doesn't silently invalidate older fixtures; it requires
  explicit re-capture per day.
- **No hidden state.** `decoded_days` becomes part of the fixture for
  velocity-layer goldens, or the HSMM decode is what's being tested
  and the input is observation tensor inputs only. Either way the
  test is closed.

### What this does *not* do

- Does not anonymise. Fixtures still contain real GPS, real place
  names, real biometric series. They stay gitignored.
- Does not add CI integration. Golden-v2 remains a local-only check
  until anonymisation or synthesis lands. The gain is reproducibility
  on a developer's machine, not CI.
- Does not change the HSMM, the velocity pipeline, or any classifier
  behaviour. Pure refactor + new I/O layer.
- Does not address the cascade-vs-scorer split (#177). That is a
  separate decision about which classifier path is canonical; once
  goldens are deterministic, that decision can be made by comparing
  fixture outputs across both paths.
- Does retire `USE_CONTINUITY_CONTINUATION` once HSMM goldens land
  (Phase 9). Any other "we needed a flag because we couldn't test
  this safely" can retire on the same pattern.

## Phasing

Each phase is small enough to bisect against, large enough to be
useful on its own. Phases land in order; nothing is half-shipped.

### Phase 1: `ClassificationInputs` type + production loader

- Define the interface in `src/geo/classification-inputs.ts`.
- Implement `loadClassificationInputs(config, userId, date, tz)` by
  lifting the DB reads currently at the top of `computeVelocity`.
- No callers move yet; the loader exists as a duplicate of the live
  read path. Test: running it produces the same in-memory values as
  inlining.
- Outcome: a place where every external read for a (user, date) is
  named.

### Phase 2: Refactor `computeVelocity` to take inputs

- Change `computeVelocity(config, userId, date, tz)` to
  `computeVelocity(inputs)`.
- Update callers (`/api/velocity`, `capture-day`, `golden-check`,
  `decode-day` if it reuses) to call `loadClassificationInputs` then
  `computeVelocity`.
- All existing tests still pass (no behaviour change).
- Outcome: `computeVelocity` is pure-in-inputs. No
  `selectFrom`/`openPhoneTrack` inside. Same for `decodeAndPersist` in
  a follow-up.

### Phase 3: Fixture serialisation + `capture-day-v2`

- Define `CapturedDay` zod schema with `fixtureFormatVersion: 1`.
- Implement `serializeInputs` / `deserializeInputs`.
- Implement `capture-day-v2 <date> <user> <tz>` CLI. Writes to
  `tests/golden/days/<date>-<user>.json`.
- Test: capture a day, deserialize, byte-equal what came in.
- Outcome: one new CLI; one new fixture lives on disk.

### Phase 4: `golden-check-v2` + migration of one golden

- Implement `golden-check-v2.js`. Reads `tests/golden/days/*.json`,
  runs `computeVelocity(fixture.inputs)`, diffs against
  `fixture.expected.velocity`. `--bless` updates expected.
- Pick one existing golden day (e.g. 2026-05-15 — multi-modal, no
  known sparse-day weirdness). Run `capture-day-v2` to produce the
  v2 fixture. Verify the v2 output matches the v1 expected baseline.
  Commit the v2 fixture.
- Both v1 and v2 harnesses pass for that day.
- Outcome: proof of concept on one day end-to-end.

### Phase 5: Migrate the remaining 9 golden days

- Run `capture-day-v2` for each remaining day in the v1 manifest.
- For each: verify v2 expected matches v1 expected (or document why
  it doesn't — could be the same drift this proposal is solving for).
- Commit each migration as its own commit so any per-day surprise is
  bisectable.

### Phase 6: Decommission v1

- Delete `tests/golden/manifest.json`, `tests/golden/expected/`,
  `src/cli/golden-check.ts`, `src/cli/capture-day.ts`,
  `scripts/golden.sh`.
- Rename `golden-check-v2.js` → `golden-check.js`,
  `capture-day-v2.js` → `capture-day.js`, etc.
- Update `npm run golden` to point at the new harness.
- Outcome: one harness, one format, no parallel maintenance.

### Phase 7: HSMM-layer refactor — `HsmmInputs` + production loader

- Define `HsmmInputs` (the closure of `decodeAndPersist`'s reads:
  filtered points after Kalman, biometrics, focus_places, OSM, route
  graph, and `presence_log[date-1]`).
- Implement `loadHsmmInputs(config, userId, date, tz)`.
- Refactor `decodeAndPersist(config, userId, date, ...)` to
  `decodeHsmm(inputs: HsmmInputs): HsmmResult` + a thin wrapper that
  calls `loadHsmmInputs` then `decodeHsmm` then persists. Production
  cron and `decode-day` CLI use the wrapper; tests use `decodeHsmm`.
- No behaviour change.

### Phase 8: HSMM-isolated golden harness

- Fixture format `tests/golden/decoded_days/<date>-<user>.json`:
  `HsmmInputs` + expected decoded segments.
- `capture-hsmm-day-v2` + `golden-check-hsmm-v2`.
- Migrate hospital-week days (a small set first) as HSMM goldens,
  since cross-day continuity is HSMM-layer behaviour and is exactly
  what got us here.

### Phase 9: Decommission HSMM flags

- With HSMM goldens in place, the continuity flag's "we can't yet
  test this safely" rationale evaporates. Remove
  `USE_CONTINUITY_CONTINUATION`; ship default-on. Same for any other
  HSMM-gating flag that exists only because we couldn't isolate it.
- This is the payoff: feature flags retire once tests can hold the
  behaviour they were protecting.

## End state

```
production:
  /api/velocity      → loadClassificationInputs(...) → computeVelocity(inputs)
  decode-day cron    → loadHsmmInputs(...)       → decodeHsmm(inputs) → persist
  capture-day        → loadClassificationInputs(...) → write fixture
  capture-hsmm-day   → loadHsmmInputs(...)       → write fixture

tests:
  golden-check       → read fixture → computeVelocity(inputs)   → diff expected
  golden-check-hsmm  → read fixture → decodeHsmm(inputs)        → diff expected

  No DB. No network. Pure functions only.
```

Two pure pipelines, two thin wrappers, two fixture types. No flags
protecting un-tested code paths. No `decoded_days` drift hiding
behaviour change.

## Open questions

1. **Fixture size**: capturing the full OSM bbox for a day with a
   long train run can be megabytes. Acceptable on local disk; would
   matter for CI. Note for the anonymisation/CI follow-on.

2. **PhoneTrack response replay**: capturing the three-window
   PhoneTrack fetch as JSON is straightforward. Replaying it in a
   test means the pipeline's HTTP layer needs an injection point.
   The cleanest answer: `loadClassificationInputs` calls a
   `PhonetrackSource` interface; production passes the HTTP
   implementation, fixtures pass an in-memory one. Not a big change
   if we plan for it in Phase 1.

3. **`decoded_days` as input vs computed**: for velocity-layer
   goldens, the HSMM output is an input (so we don't have to
   re-decode at test time). For HSMM-layer goldens, it's the output.
   Phase 4-6 covers the velocity case; Phase 7 the HSMM case.

4. **Schema evolution**: when a new column is added to e.g.
   `focus_places`, existing fixtures lack it. Two choices:
   - Bump `fixtureFormatVersion`, refuse to load old fixtures,
     require re-capture (clean but expensive).
   - Make the schema permissive (zod defaults), let old fixtures load
     with missing fields as null/default (organic migration).
   Lean toward the second; bump version only when the missing field
   changes classifier output.

5. **Multi-day chains**: presence-continuity uses the prior day's
   `presence_log` row. For a multi-day chain golden (testing the
   chain itself), each day needs the prior day's fixture's `expected`
   to be its `presenceLogPriorDay` input. The fixture format
   supports this naturally — the dependency is just on
   `presence_log[date-1]`, which is captured as part of each day's
   inputs.

## What "done" looks like

- `tests/golden/days/*.json` is the single source of truth for golden
  expectations.
- `golden-check.js` reads no DB, no network. Exit 0 = pure-function
  equality.
- Re-running any commit's `golden-check.js` produces the same result.
  No flakiness from mining cycles, cron writes, or PhoneTrack drift.
- Capture is a deliberate act: `capture-day` or `recapture-day` with
  explicit `--bless` to accept a diff. Goldens cannot drift without
  an audited commit.
- The 2026-06-03 confusion is structurally impossible.
