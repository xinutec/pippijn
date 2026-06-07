/**
 * CLI: golden-day regression check (deterministic).
 *
 * Replays each captured fixture under tests/golden/days/ — the input
 * closure of one real prod day (bounded row-sets + a recorded OSM trace)
 * — through the pure classification core and diffs the resulting
 * day-state timeline (the "Your Day" view) against the fixture's
 * `expected.velocity` baseline.
 *
 * No DB. No network. No port-forward. Re-running this on the same fixture
 * from any commit produces the same result: the OSM-mirror / decoded_days
 * drift that used to make the corpus rot between runs cannot reach it
 * (that nondeterminism is what motivated `docs/proposals/2026-06-
 * deterministic-fixtures.md`). A pipeline change that moves an OSM call
 * site surfaces as an "uncaptured query" error pointing at the cause,
 * not as a downstream diff.
 *
 * The corpus is local-only and gitignored — real prod days carry real
 * coordinates, place names and biometrics that must never enter the repo
 * (see the no-private-info-in-tests feedback memory):
 *
 *   tests/golden/days/<date>-<user>.json     — captured fixtures
 *   tests/golden/ground-truth/<date>.md      — user-confirmed truth
 *
 * Capture a day with `npm run capture-golden` (that is the only path that
 * touches prod). Then:
 *
 *   npm run golden                    # check every captured day
 *   npm run golden -- --bless         # re-derive every expected
 *   npm run golden -- --bless 2026-05-15
 *
 * `--bless` re-derives `expected.velocity` from the pipeline run against
 * the ALREADY-CAPTURED inputs; it never re-pulls from prod.
 *
 * Exit 0 = every fixture matches (or was blessed).
 * Exit 1 = at least one regressed (or threw an uncaptured-query error).
 * Exit 2 = no corpus.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGroundTruth } from "../eval/ground-truth.js";
import { classifyDay, parsePipelineState } from "../eval/truth-check.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";
import { diffStates, normalizeStates } from "./state-diff.js";

const GOLDEN_DIR = path.join(process.cwd(), "tests", "golden");
const DAYS_DIR = path.join(GOLDEN_DIR, "days");
const GROUND_TRUTH_DIR = path.join(GOLDEN_DIR, "ground-truth");

/** Minimal day-state shape the truth report needs from the replay's
 *  `states`. */
interface StateWindow {
	startTs: number;
	endTs: number;
	mode: string;
	place?: string | null;
	wayName?: string | null;
}

/**
 * Provenance-aware truth check, layered ON TOP of the snapshot diff. Loads
 * the day's `ground-truth/<date>.md` (if any), classifies each row against
 * the replayed states via {@link classifyDay}, and renders a one-line
 * summary plus any `regressed` (a confirmed truth broke) and `cleared` (a
 * known error got fixed) rows. Returns null when no ground-truth file or no
 * enforceable truth exists. Informational: the snapshot diff is the gate;
 * the truth layer is how a frozen-but-wrong day (e.g. the LSHTM / hospital
 * mislabels the deterministic capture preserves) stays honestly visible.
 */
async function truthReport(date: string, tz: string, states: readonly StateWindow[]): Promise<string | null> {
	let md: string;
	try {
		md = await readFile(path.join(GROUND_TRUTH_DIR, `${date}.md`), "utf8");
	} catch {
		return null; // no ground-truth file for this day
	}
	const gt = parseGroundTruth(md, date, tz);
	const stateAt = (startTs: number, endTs: number): StateWindow | null => {
		const mid = (startTs + endTs) / 2;
		return states.find((s) => s.startTs <= mid && mid < s.endTs) ?? null;
	};
	const res = classifyDay(gt.rows, (row) => parsePipelineState(stateAt(row.startTs, row.endTs)));
	const enforceable = res.verified + res.regressed + res.knownError + res.cleared;
	if (enforceable === 0) return null; // nothing the ground truth can enforce yet

	const lines: string[] = [
		`    truth: ${res.verified} verified · ${res.knownError} known-error · ${res.cleared} cleared · ` +
			`${res.regressed} regressed  (${res.unverified} unverified)`,
	];
	for (const { row, verdict } of res.verdicts) {
		if (verdict === "regressed")
			lines.push(`      ✗ REGRESSED ${row.windowText}: confirmed "${row.blessedText}" no longer holds`);
		if (verdict === "cleared")
			lines.push(`      ✓ cleared    ${row.windowText}: known error "${row.blessedText}" is fixed`);
	}
	return lines.join("\n");
}

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
		`No golden fixtures found at ${DAYS_DIR}.\n` +
			`Capture one against the prod DB:\n` +
			`  npm run capture-golden -- <date> <user> <timezone>`,
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

	let states: Awaited<ReturnType<typeof computeVelocityFromInputs>>["states"];
	let actual: ReturnType<typeof normalizeStates>;
	try {
		const result = await computeVelocityFromInputs(inputsFromFixture(captured));
		states = result.states;
		actual = normalizeStates(states, captured.meta.tz);
	} catch (e) {
		// An uncaptured-query throw means the pipeline reached an OSM call
		// site the fixture didn't record — a moved/added call site. That is
		// a real change to review, surfaced at its cause.
		regressions++;
		console.log(`\nFAIL     ${label}`);
		console.log(`    ${e instanceof Error ? e.message : String(e)}`);
		console.log(
			`    re-capture: npm run capture-golden -- ${captured.meta.date} ${captured.meta.user} ${captured.meta.tz}\n`,
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
				`    If intentional, re-bless: npm run golden -- --bless ${captured.meta.date}\n`,
		);
	}

	// Provenance-aware truth report (informational, on top of the diff).
	const truth = await truthReport(captured.meta.date, captured.meta.tz, states as StateWindow[]);
	if (truth) console.log(truth);
}

if (bless) {
	console.log(`\nBlessed ${blessed} day(s).`);
	process.exit(0);
}

console.log(
	`\n${checked - regressions}/${checked} fixture(s) match baseline` +
		(regressions > 0 ? `, ${regressions} regressed.` : "."),
);
process.exit(regressions > 0 ? 1 : 0);
