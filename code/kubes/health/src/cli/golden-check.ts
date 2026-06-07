/**
 * CLI: golden-day regression check.
 *
 * Runs the classification pipeline against a curated set of real prod
 * days and diffs the resulting day-state timeline — the "Your Day"
 * view the website renders — against a stored baseline. Run it before
 * a large change to catch unintended regressions, and after one to
 * review the intentional changes as a readable diff.
 *
 * The corpus is local-only and gitignored. Real prod days carry real
 * coordinates, place names and biometrics, which must never enter the
 * repo (see the no-private-info-in-tests feedback memory). The corpus:
 *
 *   tests/golden/manifest.json            — the days under test
 *   tests/golden/expected/<date>-<user>.json — each day's baseline
 *
 * Connection: the pipeline reads GPS, biometrics and the cached OSM
 * mirror from the prod DB. Run locally against a port-forwarded DB —
 * one command sets up both hops:
 *
 *   ssh -L 13306:127.0.0.1:13306 root@isis.xinutec.org \
 *       "kubectl -n health port-forward svc/health-db 13306:3306"
 *
 * then, in another shell, with DB_HOST=127.0.0.1 DB_PORT=13306 and the
 * usual DB_USER / DB_PASSWORD / DB_NAME / NC_* env:
 *
 *   node dist/cli/golden-check.js                    # check every day
 *   node dist/cli/golden-check.js --bless            # re-bless every day
 *   node dist/cli/golden-check.js --bless 2026-05-15 # re-bless one day
 *
 * Exit 0 = every day matches its baseline (or was blessed).
 * Exit 1 = at least one day regressed.
 * Exit 2 = bad usage / no corpus.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { parseGroundTruth } from "../eval/ground-truth.js";
import { classifyDay, parsePipelineState } from "../eval/truth-check.js";
import { computeVelocity } from "../geo/velocity.js";
import { diffStates, type NormalizedState, normalizeStates } from "./state-diff.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
		nextcloud: z.object({
			baseUrl: z.string().url().default("https://dash.xinutec.org"),
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
		}),
	})
	.parse({
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
			clientId: process.env.NC_CLIENT_ID,
			clientSecret: process.env.NC_CLIENT_SECRET,
		},
	});

const GOLDEN_DIR = path.join(process.cwd(), "tests", "golden");
const MANIFEST_PATH = path.join(GOLDEN_DIR, "manifest.json");
const EXPECTED_DIR = path.join(GOLDEN_DIR, "expected");
const GROUND_TRUTH_DIR = path.join(GOLDEN_DIR, "ground-truth");

/** Minimal day-state shape the truth report needs from computeVelocity's
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
 * the live states via {@link classifyDay}, and renders a one-line summary
 * plus any `regressed` (a confirmed truth broke) and `cleared` (a known error
 * got fixed) rows. Returns null when no ground-truth file or no enforceable
 * truth exists — keeps untagged days quiet. Informational for now: the
 * snapshot diff is still the gate until more days carry provenance tags.
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

const manifestSchema = z.array(
	z.object({
		date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		user: z.string().min(1),
		tz: z.string().min(1),
		/** Why this day is in the corpus — which scenario or past bug
		 *  it exercises. Never a personal journey narrative. */
		description: z.string().default(""),
	}),
);
type ManifestEntry = z.infer<typeof manifestSchema>[number];

interface ExpectedFile {
	date: string;
	user: string;
	tz: string;
	blessed_at: string;
	states: NormalizedState[];
}

function expectedPath(entry: ManifestEntry): string {
	return path.join(EXPECTED_DIR, `${entry.date}-${entry.user}.json`);
}

async function loadManifest(): Promise<ManifestEntry[]> {
	let raw: string;
	try {
		raw = await readFile(MANIFEST_PATH, "utf8");
	} catch {
		console.error(
			`No golden corpus found at ${MANIFEST_PATH}.\n` +
				`The corpus is local-only (gitignored). Create the manifest, then\n` +
				`run with --bless to record each day's baseline. See the header of\n` +
				`this file for the manifest format and the port-forward command.`,
		);
		process.exit(2);
	}
	return manifestSchema.parse(JSON.parse(raw));
}

async function loadExpected(entry: ManifestEntry): Promise<ExpectedFile | null> {
	try {
		const raw = await readFile(expectedPath(entry), "utf8");
		return JSON.parse(raw) as ExpectedFile;
	} catch {
		return null;
	}
}

async function writeExpected(entry: ManifestEntry, states: NormalizedState[]): Promise<void> {
	const file: ExpectedFile = {
		date: entry.date,
		user: entry.user,
		tz: entry.tz,
		blessed_at: new Date().toISOString(),
		states,
	};
	await mkdir(EXPECTED_DIR, { recursive: true });
	await writeFile(expectedPath(entry), `${JSON.stringify(file, null, "\t")}\n`, "utf8");
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

const manifest = await loadManifest();

initPool(config.db);
await withConnection(migrate);

let regressions = 0;
let blessed = 0;
let checked = 0;

for (const entry of manifest) {
	if (blessDate && entry.date !== blessDate) continue;

	const label = `${entry.date} ${entry.user}${entry.description ? ` — ${entry.description}` : ""}`;
	const { states } = await computeVelocity(config, entry.user, entry.date, entry.tz);
	const actual = normalizeStates(states, entry.tz);

	if (bless) {
		await writeExpected(entry, actual);
		blessed++;
		console.log(`blessed  ${label}  (${actual.length} states)`);
		continue;
	}

	checked++;
	const expected = await loadExpected(entry);
	if (!expected) {
		regressions++;
		console.log(`\nMISSING  ${label}`);
		console.log(`    no baseline — run: golden-check.js --bless ${entry.date}`);
		continue;
	}

	const d = diffStates(expected.states, actual);
	if (d.identical) {
		console.log(`PASS     ${label}`);
	} else {
		regressions++;
		console.log(`\nFAIL     ${label}`);
		for (const ln of d.lines) console.log(ln);
		console.log(
			`    baseline blessed ${expected.blessed_at}. If this change is\n` +
				`    intentional, re-bless: golden-check.js --bless ${entry.date}\n`,
		);
	}

	// Provenance-aware truth report (informational, on top of the diff).
	const truth = await truthReport(entry.date, entry.tz, states as StateWindow[]);
	if (truth) console.log(truth);
}

if (bless) {
	console.log(`\nBlessed ${blessed} day(s).`);
	process.exit(0);
}

console.log(
	`\n${checked - regressions}/${checked} day(s) match baseline` +
		(regressions > 0 ? `, ${regressions} regressed.` : "."),
);
process.exit(regressions > 0 ? 1 : 0);
