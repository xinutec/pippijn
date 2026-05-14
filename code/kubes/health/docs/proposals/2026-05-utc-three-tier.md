---
status: active
created: 2026-05-14
updated: 2026-05-14
references:
  - ../design/timezone.md
---

# UTC + provenance: three-tier timestamp storage

The four Fitbit biometric tables that store wall-clock DATETIMEs
(`heart_rate_intraday`, `steps_intraday`, `sleep_stages`, `sleep`)
currently force every read to do a per-row `fitbitTsToUnix(ts, tz)`
conversion. The conversion is cheap individually but blocks two
optimisations: tight range filters (we use ±1 day date-string
padding today, then trim by unix after parsing) and the cleaner
mental model of "give me HR between two UTC instants."

This proposal adds `ts_utc` (derived) and `tz_source` (provenance)
columns alongside the existing `ts` (wall-clock) and `tz` columns.
The framing is deliberately three-tier so future improvements to tz
inference can recompute `ts_utc` without losing the verbatim Fitbit
response.

## Three tiers

1. **Source of truth (immutable):** `ts` — the verbatim wall-clock
   DATETIME from Fitbit. Never overwritten after first insert.
2. **Derived (recomputable):** `ts_utc` and `tz`. Computed from
   `ts` + the current best tz signal (PhoneTrack, home_tz fallback,
   manual overrides, future signals). Can be re-derived at any time
   from tier 1 by running a recompute CLI.
3. **Provenance (optional):** `tz_source` — short tag describing
   which signal produced this row's `tz` (`phonetrack`, `home_tz`,
   `manual`, `null`). Lets a future recompute target only weakly-
   resolved rows. NULL when the row predates the column.

The existing `tz` column joins tier 2 — already derived, already
recomputable.

## Storage choice — DATETIME as UTC, not BIGINT unix

`ts_utc DATETIME` interpreted as UTC. The alternative
(BIGINT unix seconds) is more rigorous but loses query ergonomics
(`BETWEEN '2026-04-29 00:00:00' AND '2026-04-30 00:00:00'` needs
`UNIX_TIMESTAMP()`). MariaDB DATETIME stores no tz; the column
documentation declares "this is UTC, by convention." Same compromise
PhoneTrack already uses.

## Affected tables

| Table | Wall-clock column | New columns |
|---|---|---|
| `heart_rate_intraday` | `ts` | `ts_utc`, `tz_source` |
| `steps_intraday` | `ts` | `ts_utc`, `tz_source` |
| `sleep_stages` | `ts` | `ts_utc`, `tz_source` |
| `sleep` | `start_time`, `end_time` | `start_time_utc`, `end_time_utc`, `tz_source` |

All new columns NULLABLE. Backfill happens after the migration; new
writes populate immediately.

## Indexing

The current PK on each intraday table is `(user_id, ts)`. After
migration, range queries should hit `ts_utc`. Add a secondary index
`(user_id, ts_utc)`. Don't change the PK — the wall-clock PK still
deduplicates inserts correctly (Fitbit's response is keyed on the
wall-clock minute).

For `sleep`, no new index needed — it's small (one row per night).

**Index timing.** `ADD INDEX` on `heart_rate_intraday` (28M rows) is
not instant; it's an online INPLACE build that can take 10+ minutes
and noticeably increase iowait while running. Build the index in
Phase C (after Phase B has populated the column), not in Phase A.
Building an index over a half-populated column is wasted work, and
slow DDL inside the startup-path migration block risks the pod's
liveness probe killing it mid-build.

## Migration strategy — additive, online, deploy in three phases

### Phase A: schema + sync write path

One commit, one deploy:

1. Migration v34: `ALTER TABLE ... ADD COLUMN ts_utc DATETIME NULL,
   ADD COLUMN tz_source VARCHAR(32) NULL` for the three intraday
   tables; equivalent (start_time_utc + end_time_utc + tz_source) for
   `sleep`. MariaDB INSTANT-add → <1s. The secondary
   `(user_id, ts_utc)` index is deferred to Phase C.
2. Extend the row tuples produced by `parseHRDataset`,
   `parseStepsDataset`, `parseSleepStages`, `parseSleepLog` to
   include `ts_utc` and `tz_source`. The tuple grows from 4 to 6
   slots (or equivalent for sleep).
3. Update each `INSERT ... ON DUPLICATE KEY UPDATE` to write the new
   columns: `ts_utc = COALESCE(ts_utc, VALUES(ts_utc))`,
   `tz_source = COALESCE(tz_source, VALUES(tz_source))`. Same
   first-non-NULL-wins semantics as the existing `tz` column.
4. Compute `ts_utc` in each parser by calling
   `wallClockToUtcString(ts, tz)`. When `tz === null`, leave
   `ts_utc = null`.
5. Leave `tz_source = NULL` at write time for now. Tagging forward-
   sync rows with their provenance (`phonetrack`, `home_tz`)
   requires extending `TzSource` and touching every test mock; the
   first consumer of `tz_source` is a future recompute CLI, so this
   work doesn't pay off until then. Document the gap so a future
   commit can land it as a self-contained change.

After deploy: new rows have all four (`ts`, `tz`, `ts_utc`,
`tz_source`); historical rows still have only `ts` + `tz`.

### Phase B: backfill historical rows

One CLI, one execution per table:

```sql
UPDATE heart_rate_intraday
SET ts_utc = CONVERT_TZ(ts, tz, 'UTC'),
    tz_source = 'phonetrack'   -- or 'home_tz' or 'manual'; see below
WHERE ts_utc IS NULL
  AND tz IS NOT NULL
LIMIT 100000;
```

Looped until 0 rows affected. Verified on prod: `CONVERT_TZ` works,
returns `NULL` for unknown tz strings (degrades safely).

`tz_source` for backfilled rows is harder to set retroactively
because the historic resolver didn't record provenance. Two options:

- **Pragma a**: tag all backfilled rows `null` (unknown). Honest;
  costs us the ability to target weak rows for future recompute.
- **Pragma b**: tag as `legacy` so future recompute knows "this row
  was resolved by Phase 1's resolver, may benefit from rerun." Mark
  rows where `tz === home_tz` as `legacy` and skip rows where `tz`
  matches no known seed signal.

Recommend **pragma b** with tag `legacy`. Pragma a loses information.
The recompute CLI later treats `legacy` as "candidate for rerun."

`sleep_stages` and `sleep`'s `start_time`/`end_time` follow the same
template; the sleep summary needs two CONVERT_TZ calls per row.

### Phase C: switch read path to ts_utc

One commit, one deploy. Only after Phase B has cleared the backlog.

In `loadBiometrics` (`velocity.ts:52-136`):

```ts
const startUtcStr = new Date(startUtc * 1000).toISOString().slice(0, 19).replace("T", " ");
const endUtcStr   = new Date(endUtc   * 1000).toISOString().slice(0, 19).replace("T", " ");

const hrRows = await db()
  .selectFrom("heart_rate_intraday")
  .select([
    sql<Date>`DATE_FORMAT(MIN(ts_utc), '%Y-%m-%d %H:%i:00')`.as("ts_utc"),
    sql<number>`ROUND(AVG(bpm))`.as("bpm"),
  ])
  .where("user_id", "=", userId)
  .where("ts_utc", ">=", startUtcStr)
  .where("ts_utc", "<",  endUtcStr)
  .groupBy(sql`DATE_FORMAT(ts_utc, '%Y-%m-%d %H:%i')`)
  .orderBy("ts_utc")
  .execute();

const hr: HrPoint[] = hrRows.map((r) => ({
  ts: Math.floor(Date.parse(`${r.ts_utc}Z`) / 1000),
  bpm: Number(r.bpm),
}));
```

The per-row `fitbitTsToUnix(ts, resolveTz(tz))` call goes away.
The ±1-day padding goes away. The `home_tz` lookup goes away from
this code path (still needed elsewhere for display).

Fallback for rows still missing `ts_utc` (the worst-case sliver
left over from Phase B failures or new-since-Phase-B rows whose
forward sync ran before tz was inferred): a second query reads
those rows by `ts` + `tz` and pays the per-row conversion. We
expect this set to be empty in steady state and small during the
Phase B window. Worth a metric.

## Test plan (TDD)

Unit:

- `wallClockToUtcString("2026-04-29 10:30:00", "Europe/Amsterdam")`
  returns `"2026-04-29 08:30:00"`.
- Same input across CEST↔CET transition gives correct offsets
  (March + October dates from `tests/timezone.test.ts`).
- `wallClockToUtcString(_, null)` returns `null`.
- The parser-tuple extension (`parseHRDataset`, etc.) produces the
  expected 6-tuples given a fixture response + a `TzSource` that
  returns `{ tz: "Europe/Amsterdam", source: "phonetrack" }`.

UPSERT correctness:

- Insert row with `ts_utc=NULL`, re-insert with computed value →
  upgraded.
- Re-insert with a different `ts_utc` after the first non-NULL set
  → unchanged (COALESCE preserves first non-NULL).

Backfill integrity:

- After Phase B runs over a fixture of N rows with known
  (ts, tz) values, every row has `ts_utc` matching
  `fitbitTsToUnix(ts, tz)` to the second.

Integration:

- `loadBiometrics` on April 29 fixture returns identical HR/sleep/
  steps arrays before and after Phase C switch (within rounding).
  This is the headline regression test — the migration is correct
  iff it's invisible to downstream consumers.

## Files touched

| File | Phase | Change |
|---|---|---|
| `src/db/schema.ts` | A | New migration block (v34 + v35 for sleep) |
| `src/db/tables.ts` | A | Add `ts_utc`, `tz_source` to four table interfaces |
| `src/geo/fitbit-tz.ts` | A | Extend `TzSource.forWallClock` return shape |
| `src/geo/timezone.ts` | A | New helper `wallClockToUtcString(ts, tz): string \| null` |
| `src/fitbit/sync/heartrate.ts` | A | `parseHRDataset` returns 6-tuple; INSERT updated |
| `src/fitbit/sync/steps.ts` | A | `parseStepsDataset` returns 6-tuple; INSERT updated |
| `src/fitbit/sync/sleep.ts` | A | `parseSleepStages` and `parseSleepLog` updated |
| `src/cli/backfill-utc.ts` | B | New CLI: loop CONVERT_TZ updates |
| `src/geo/velocity.ts` | C | `loadBiometrics` filters by `ts_utc` |
| `tests/timezone.test.ts` | A | `wallClockToUtcString` tests |
| `tests/heartrate-sync.test.ts` | A | `parseHRDataset` tuple shape |
| `tests/biometrics-readpath.test.ts` | C | Identical result regression |

## Risks and known limitations

1. **`CONVERT_TZ` returns NULL for unknown tz.** Verified safe — the
   UPDATE leaves `ts_utc` NULL, the read path's fallback catches it.
2. **`legacy` tag is a guess.** We're labelling historic rows with a
   provenance we can't actually verify. The honest alternative is
   `null` for everything pre-Phase-B; the `legacy` tag is a hint, not
   a claim. Document this in the column comment.
3. **Phase C deploy before Phase B completes ⇒ reads miss rows.**
   The fallback path handles it but masks the slowness. Don't
   deploy Phase C until Phase B has run to 0-rows-affected.
4. **Skinny-row sleep: start_time / end_time both need UTC versions.**
   Two CONVERT_TZ calls per row; the migration adds two new columns
   per side, not one shared one. Slightly more SQL but identical
   pattern.
5. **`tz_source` doesn't currently exist as an enum.** We pick a
   `VARCHAR(32)`. If we later want strict typing, an
   `ALTER ... MODIFY COLUMN tz_source ENUM(...)` can tighten it.

## Out of scope

- Changing the existing `tz` semantics. It stays "the IANA tz the
  wall-clock was recorded in" — still tier 2, still derived,
  still recomputable.
- Migrating PhoneTrack `fixes.ts` — already stores unix UTC.
- spo2_intraday — not currently in the read path; same migration
  template applies when it joins.
- `daily_activity` — date-only, no intraday wall-clock, no
  migration needed.

## Implementation order

1. Write `tests/timezone.test.ts` cases for `wallClockToUtcString`
   (RED).
2. Implement `wallClockToUtcString` in `src/geo/timezone.ts` (GREEN).
3. Migration v34 — add columns + index on the three intraday tables.
4. Extend `TzSource` shape + the three parsers + their INSERTs.
   Tests for parser tuple shape.
5. Migration v35 — add columns on `sleep`.
6. Update `parseSleepLog`/`parseSleepStages` + their INSERTs.
7. Deploy Phase A. Verify new rows have `ts_utc` populated.
8. Write `src/cli/backfill-utc.ts`. Run on prod per-table.
9. Verify `SELECT COUNT(*) WHERE ts_utc IS NULL AND tz IS NOT NULL`
   converges to 0.
10. Migrate `loadBiometrics` to `ts_utc` (Phase C). Regression test
    must show identical output to pre-migration.
11. Deploy Phase C.

Each step has a clear failure mode and a clear verification step.
TDD discipline: the helper, the parser tuple, and the regression
test all get failing tests written first.
