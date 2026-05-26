/**
 * Production HSMM decoder CLI: decode a (user, date) day and persist
 * the result to `decoded_days`. The output is what `velocity.ts`
 * reads for place-attribution override.
 *
 * Usage (via prod-db.sh):
 *
 *   scripts/prod-db.sh node dist/cli/decode-day.js --date 2026-05-22
 *   scripts/prod-db.sh node dist/cli/decode-day.js --user pippijn --days 14
 *
 * The `--days N` form decodes the last N days for the user. Used by
 * the cron task that keeps the cache warm. Idempotent — re-decoding
 * a day overwrites the existing row (with current classifier version).
 */

import { z } from "zod";
import { initPool, db as kyselyDb, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { parseHourProfile } from "../geo/focus-places.js";
import { stationsOnLine } from "../geo/line-stations.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, loadBiometrics } from "../geo/velocity.js";
import { DEFAULT_MIN_DURATION_BY_MODE, type GammaFit, logDurationProb } from "../hmm/duration-dist.js";
import { buildEmissionFn } from "../hmm/emissions.js";
import { buildEntryPrior } from "../hmm/entry-prior.js";
import { buildGeometricFeasibility } from "../hmm/geometric-feasibility.js";
import { dropGpsOutliers } from "../hmm/gps-outliers.js";
import { hsmmViterbi } from "../hmm/hsmm-viterbi.js";
import { buildInitialStatePrior } from "../hmm/initial-state.js";
import { buildObservationTensor } from "../hmm/observation.js";
import { groupStatesIntoSegments, saveDecode } from "../hmm/persist.js";
import { buildStateSpace, type FocusPlaceRef, type State } from "../hmm/state-space.js";
import { buildTransitionMatrix } from "../hmm/transitions.js";

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

const KNOWN_LINES = [
	"Metropolitan Line",
	"Jubilee Line",
	"Victoria Line",
	"Piccadilly Line",
	"Bakerloo Line",
	"Northern Line",
	"Circle Line",
	"Hammersmith & City Line",
	"District Line",
	"Central Line",
	"Elizabeth Line",
];

/** Baseline per-mode Gamma fits — moments-matched on 45 days of
 *  training data. Shared with `compare-vs-ground-truth.ts`; both
 *  CLIs need the same fits to produce identical decodes. Eventually
 *  these become persisted rows in `learned_hmm_models`. */
const BASELINE_DURATION_FITS: Record<State["mode"], GammaFit> = {
	stationary: { alpha: 0.85, beta: 0.0043, sampleCount: 132 },
	walking: { alpha: 1.07, beta: 0.034, sampleCount: 60 },
	cycling: { alpha: 1.0, beta: 0.05, sampleCount: 0 },
	driving: { alpha: 0.42, beta: 0.008, sampleCount: 24 },
	train: { alpha: 1.74, beta: 0.053, sampleCount: 24 },
	plane: { alpha: 1.0, beta: 0.011, sampleCount: 0 },
	unknown: { alpha: 0.45, beta: 0.0034, sampleCount: 15 },
};

interface PlaceWithCoords extends FocusPlaceRef {
	lat: number;
	lon: number;
	hourProfile: readonly number[] | null;
	totalDwellSec: number;
}

async function loadFocusPlacesForUser(userId: string): Promise<PlaceWithCoords[]> {
	const rows = await kyselyDb()
		.selectFrom("focus_places")
		.where("user_id", "=", userId)
		.select(["id", "display_name", "centroid_lat", "centroid_lon", "hour_profile", "total_dwell_sec"])
		.execute();
	return rows.map((r) => ({
		id: r.id,
		displayName: r.display_name,
		lat: Number(r.centroid_lat),
		lon: Number(r.centroid_lon),
		hourProfile: parseHourProfile(r.hour_profile),
		totalDwellSec: Number(r.total_dwell_sec),
	}));
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function buildPlaceNearLine(places: readonly PlaceWithCoords[], lines: readonly string[]): Promise<Set<string>> {
	const WALK_DIST_M = 400;
	const set = new Set<string>();
	for (const line of lines) {
		const stations = await stationsOnLine(line);
		if (stations.length === 0) continue;
		for (const p of places) {
			for (const s of stations) {
				if (haversineMeters(p.lat, p.lon, s.lat, s.lon) <= WALK_DIST_M) {
					set.add(`${p.id}|${line}`);
					break;
				}
			}
		}
	}
	return set;
}

async function decodeAndPersist(
	userId: string,
	date: string,
	tz: string,
	places: readonly PlaceWithCoords[],
	placeNearLine: Set<string>,
): Promise<{ segmentCount: number; minuteCount: number; durationMs: number }> {
	const t0 = Date.now();
	const velResult = await computeVelocity(config, userId, date, tz);
	const bounds = dateBoundsUtc(date, tz);
	const biom = await loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz);
	const cleanedPoints = dropGpsOutliers(velResult.points);
	const tensor = buildObservationTensor({
		date,
		tz,
		points: cleanedPoints,
		hr: biom.hr,
		steps: biom.steps,
		sleep: biom.sleep,
	});
	const states = buildStateSpace({ focusPlaces: places, knownLines: KNOWN_LINES });
	const placeCoords = new Map<number, { lat: number; lon: number }>();
	const placeHourProfiles = new Map<number, readonly number[]>();
	const placeVisitWeights = new Map<number, number>();
	const totalDwell = places.reduce((s, p) => s + p.totalDwellSec, 0);
	for (const p of places) {
		placeCoords.set(p.id, { lat: p.lat, lon: p.lon });
		if (p.hourProfile !== null) placeHourProfiles.set(p.id, p.hourProfile);
		placeVisitWeights.set(p.id, totalDwell > 0 ? p.totalDwellSec / totalDwell : 1 / places.length);
	}
	const transition = buildTransitionMatrix({
		states,
		placeNearLine: (placeId, lineName) => placeNearLine.has(`${placeId}|${lineName}`),
	});
	const baseEmission = buildEmissionFn({ placeCoords });
	const geometricFn = buildGeometricFeasibility({ placeCoords });
	const emission = (state: State, obs: (typeof tensor)[number]): number =>
		baseEmission(state, obs) + geometricFn(state, obs);
	const initialLogProb = buildInitialStatePrior();
	const entryLogProb = buildEntryPrior({ placeHourProfiles, placeVisitWeights });
	const hmmStates = hsmmViterbi({
		observations: tensor,
		states,
		transitionLogProb: transition,
		emissionLogProb: emission,
		initialLogProb,
		entryLogProb,
		durationLogProb: (state, d) =>
			logDurationProb(d, state.mode, BASELINE_DURATION_FITS[state.mode], DEFAULT_MIN_DURATION_BY_MODE[state.mode]),
	});
	const timestamps = tensor.map((o) => o.ts);
	const segments = groupStatesIntoSegments(hmmStates, timestamps);
	await saveDecode(kyselyDb(), userId, date, segments);
	return {
		segmentCount: segments.length,
		minuteCount: hmmStates.length,
		durationMs: Date.now() - t0,
	};
}

interface CliArgs {
	userId: string;
	tz: string;
	dates: string[];
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let userId = "pippijn";
	let tz = "Europe/London";
	let days = 1;
	let explicitDate: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--user") userId = args[++i] ?? userId;
		else if (a === "--tz") tz = args[++i] ?? tz;
		else if (a === "--days") days = Number(args[++i] ?? days) || days;
		else if (a === "--date") explicitDate = args[++i] ?? null;
	}
	let dates: string[];
	if (explicitDate) {
		dates = [explicitDate];
	} else {
		dates = [];
		const now = new Date();
		for (let d = 1; d <= days; d++) {
			const date = new Date(now);
			date.setUTCDate(now.getUTCDate() - d);
			dates.push(date.toISOString().slice(0, 10));
		}
	}
	return { userId, tz, dates };
}

async function main(): Promise<void> {
	const { userId, tz, dates } = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	console.error(`# decode-day — user=${userId} tz=${tz} dates=${dates.join(",")}`);
	const places = await loadFocusPlacesForUser(userId);
	const placeNearLine = await buildPlaceNearLine(places, KNOWN_LINES);
	console.error(`# loaded ${places.length} focus_places, ${placeNearLine.size} place-line pairs`);

	for (const date of dates) {
		try {
			const result = await decodeAndPersist(userId, date, tz, places, placeNearLine);
			console.log(
				`  ${date}: ${result.segmentCount} segments / ${result.minuteCount} minutes in ${result.durationMs}ms`,
			);
		} catch (e) {
			console.error(`  ${date} FAILED: ${e instanceof Error ? e.message : e}`);
		}
	}
	process.exit(0);
}

await main();
