/**
 * CLI: deterministic golden check (v2).
 *
 * Phase 6f of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Reads each captured fixture under tests/golden/days/, rebuilds the
 * day's `ClassificationInputs` with a `FixtureOsmAdapter` over the
 * recorded OSM trace, runs the pure classification core, and diffs the
 * normalised day-state timeline against the fixture's `expected.velocity`.
 *
 * No DB. No network. Re-running this on the same fixture from any commit
 * produces the same result — the OSM-mirror / decoded_days drift that
 * made the v1 corpus non-deterministic cannot reach it. A pipeline change
 * that moves an OSM call site surfaces as an "uncaptured query" error
 * pointing at the cause, not as a downstream diff.
 *
 *   node dist/cli/golden-check-v2.js                    # check every day
 *   node dist/cli/golden-check-v2.js --bless            # re-derive every expected
 *   node dist/cli/golden-check-v2.js --bless 2026-05-15 # one day
 *
 * `--bless` re-derives `expected.velocity` from the pipeline run against
 * the ALREADY-CAPTURED inputs; it never re-pulls from prod. To refresh
 * inputs, run capture-day-v2.
 *
 * Exit 0 = every fixture matches (or was blessed).
 * Exit 1 = at least one regressed (or threw an uncaptured-query error).
 * Exit 2 = no corpus.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";
import { diffStates, normalizeStates } from "./state-diff.js";

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

const args = process.argv.slice(2);
let bless = false;
let blessDate: string | null = null;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--bless") {
		bless = true;
		const next = args[i + 1];
		if (next && /^\d{4}-\d{2}-\d{2}$/.test(next)) {
			blessDate = next;
			i++;
		}
	} else {
		console.error(`unknown argument: ${args[i]}`);
		process.exit(2);
	}
}

let files: string[];
try {
	files = (await readdir(DAYS_DIR)).filter((f) => f.endsWith(".json")).sort();
} catch {
	files = [];
}
if (files.length === 0) {
	console.error(
		`No v2 fixtures found at ${DAYS_DIR}.\n` +
			`Capture one against a port-forwarded prod DB:\n` +
			`  node dist/cli/capture-day-v2.js <date> <user> <timezone>`,
	);
	process.exit(2);
}

let regressions = 0;
let blessed = 0;
let checked = 0;

for (const file of files) {
	const full = path.join(DAYS_DIR, file);
	const captured = parseCapturedDay(await readFile(full, "utf8"));
	if (blessDate && captured.meta.date !== blessDate) continue;

	const label = `${captured.meta.date} ${captured.meta.user}${captured.meta.description ? ` — ${captured.meta.description}` : ""}`;

	let actual: ReturnType<typeof normalizeStates>;
	try {
		const result = await computeVelocityFromInputs(inputsFromFixture(captured));
		actual = normalizeStates(result.states, captured.meta.tz);
	} catch (e) {
		// An uncaptured-query throw means the pipeline reached an OSM call
		// site the fixture didn't record — a moved/added call site. That is
		// a real change to review, surfaced at its cause.
		regressions++;
		console.log(`\nFAIL     ${label}`);
		console.log(`    ${e instanceof Error ? e.message : String(e)}`);
		console.log(
			`    re-capture: node dist/cli/capture-day-v2.js ${captured.meta.date} ${captured.meta.user} ${captured.meta.tz}\n`,
		);
		continue;
	}

	if (bless) {
		const updated: CapturedDay = { ...captured, expected: { velocity: actual } };
		await writeFile(full, `${JSON.stringify(updated, null, "\t")}\n`, "utf8");
		blessed++;
		console.log(`blessed  ${label}  (${actual.length} states)`);
		continue;
	}

	checked++;
	const d = diffStates(captured.expected.velocity, actual);
	if (d.identical) {
		console.log(`PASS     ${label}`);
	} else {
		regressions++;
		console.log(`\nFAIL     ${label}`);
		for (const ln of d.lines) console.log(ln);
		console.log(
			`    captured ${captured.meta.capturedAt} @ ${captured.meta.capturedAtCodeSha.slice(0, 8)}.\n` +
				`    If intentional, re-bless: golden-check-v2.js --bless ${captured.meta.date}\n`,
		);
	}
}

if (bless) {
	console.log(`\nBlessed ${blessed} day(s).`);
	process.exit(0);
}

console.log(
	`\n${checked - regressions}/${checked} fixture(s) match` + (regressions > 0 ? `, ${regressions} regressed.` : "."),
);
process.exit(regressions > 0 ? 1 : 0);
