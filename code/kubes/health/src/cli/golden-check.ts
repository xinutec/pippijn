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
import { computeVelocity } from "../geo/velocity.js";
import type { DayState } from "../sleep/day-state.js";

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

/** One state row, reduced to exactly what the timeline renders.
 *  Timestamps become wall-clock HH:MM so the baseline is readable and
 *  stable across the UTC columns. */
interface GoldenState {
	from: string;
	to: string;
	mode: string;
	/** "@ <place>" for stays, "on <way>" for moving, "" otherwise. */
	label: string;
	asleep: boolean;
}

interface ExpectedFile {
	date: string;
	user: string;
	tz: string;
	blessed_at: string;
	states: GoldenState[];
}

function hhmm(ts: number, tz: string): string {
	return new Date(ts * 1000).toLocaleTimeString("en-GB", {
		timeZone: tz,
		hour: "2-digit",
		minute: "2-digit",
	});
}

function normalizeStates(states: DayState[], tz: string): GoldenState[] {
	return states.map((s) => ({
		from: hhmm(s.startTs, tz),
		to: hhmm(s.endTs, tz),
		mode: s.mode,
		label: s.place ? `@ ${s.place}` : s.wayName ? `on ${s.wayName}` : "",
		asleep: s.asleep ?? false,
	}));
}

/** Canonical one-line rendering of a state, for diffing and display. */
function line(s: GoldenState): string {
	const tag = s.asleep ? " (asleep)" : "";
	return `${s.from}-${s.to}  ${s.mode.padEnd(11)}${tag}${s.label ? ` ${s.label}` : ""}`;
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

async function writeExpected(entry: ManifestEntry, states: GoldenState[]): Promise<void> {
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

/** Index-aligned diff of two state lists. Returns whether they are
 *  identical, plus the rendered diff lines (printed by the caller,
 *  after the day's result header). */
function diff(expected: GoldenState[], actual: GoldenState[]): { identical: boolean; lines: string[] } {
	const n = Math.max(expected.length, actual.length);
	const lines: string[] = [];
	let identical = expected.length === actual.length;
	for (let i = 0; i < n; i++) {
		const e = expected[i];
		const a = actual[i];
		const eLine = e ? line(e) : null;
		const aLine = a ? line(a) : null;
		if (eLine === aLine) {
			lines.push(`    ok   ${eLine}`);
			continue;
		}
		identical = false;
		if (eLine !== null) lines.push(`    -    ${eLine}`);
		if (aLine !== null) lines.push(`    +    ${aLine}`);
	}
	return { identical, lines };
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

	const d = diff(expected.states, actual);
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
