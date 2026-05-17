/**
 * CLI tool: diagnose why a day's rail journeys did or did not get a
 * snapped track on the map.
 *
 * The Map tab draws a `snappedPath` — fixes map-matched onto the OSM
 * rail track — only for train segments that carry a `railLine`. And
 * `railLine` is set by *one* path: the underground reconstruction,
 * which needs a run of coarse cell-network fixes. So an overground
 * train (good GPS, no coarse run) or a tube run the reconstruction
 * could not resolve gets no snapped path, and the raw zigzag stays.
 *
 * This tool runs the real pipeline for a day, then for every moving
 * segment reports: the raw-fix accuracy spread, whether a line was
 * identified, and — when one was — re-runs the rail-snap lookup stage
 * by stage (geometry fetch → stitch → snap → offsets) so a failure is
 * attributable to a specific step. Read-only; no DB writes.
 *
 * Usage (via scripts/prod-db.sh, or in-pod with DB env set):
 *   node dist/cli/diagnose-rail-snap.js [date] [user] [timezone]
 *
 * Default date: yesterday. Default user: pippijn.
 */

import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { linesAtPoint } from "../geo/osm.js";
import { queryRouteGeometry } from "../geo/osm-local.js";
import { parseRailLine, projectOntoPolyline, snapFixesToRoute, stitchWays } from "../geo/rail-snap.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { COARSE_ACCURACY_M, COARSE_ACCURACY_MAX_M } from "../geo/underground-rail.js";
import { computeVelocity } from "../geo/velocity.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";

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

const date =
	process.argv[2] ??
	(() => {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		return d.toISOString().slice(0, 10);
	})();
const userId = process.argv[3] ?? "pippijn";
const tz = process.argv[4];

initPool(config.db);
await withConnection(migrate);

const fmt = (ts: number): string =>
	tz
		? new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" })
		: new Date(ts * 1000).toISOString().slice(11, 16);

/** Straight-line metres — equirectangular, fine at journey scale. */
function meters(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((aLat * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

function quantiles(xs: number[]): { p50: number; p90: number; max: number } {
	if (xs.length === 0) return { p50: 0, p90: 0, max: 0 };
	const s = [...xs].sort((a, b) => a - b);
	const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))];
	return { p50: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}

console.log(`Rail-snap diagnosis — ${date} / ${userId}${tz ? ` (${tz})` : ""}\n`);

// --- raw fixes: what the phone actually reported -------------------------
const nextDay = (() => {
	const d = new Date(date);
	d.setDate(d.getDate() + 1);
	return d.toISOString().slice(0, 10);
})();
const bounds = dateBoundsUtc(date, tz);
const raw = (await fetchTrackPoints(config, userId, date, nextDay)).filter(
	(p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc,
);

const accBucket = (a: number | null): string => {
	if (a == null) return "null";
	if (a < 50) return "<50m";
	if (a < COARSE_ACCURACY_M) return "50-100m";
	if (a < 300) return "100-300m";
	if (a <= COARSE_ACCURACY_MAX_M) return "300-800m";
	return ">800m";
};
const buckets = new Map<string, number>();
for (const p of raw) buckets.set(accBucket(p.accuracy), (buckets.get(accBucket(p.accuracy)) ?? 0) + 1);
console.log(`Raw fixes in day: ${raw.length}`);
console.log(
	`  accuracy: ${["<50m", "50-100m", "100-300m", "300-800m", ">800m", "null"].map((b) => `${b}:${buckets.get(b) ?? 0}`).join("  ")}`,
);
console.log(
	`  (coarse = ${COARSE_ACCURACY_M}-${COARSE_ACCURACY_MAX_M}m — the band underground reconstruction mines)\n`,
);

// --- run the real pipeline ----------------------------------------------
const { segments } = await computeVelocity(config, userId, date, tz);
const isCoarse = (a: number | null): boolean => a != null && a >= COARSE_ACCURACY_M && a <= COARSE_ACCURACY_MAX_M;

console.log(`=== Segments (${segments.length}) ===`);
for (const s of segments) {
	const mode = s.refinedMode ?? s.mode;
	const inWin = raw.filter((p) => p.ts >= s.startTs && p.ts <= s.endTs);
	const coarse = inWin.filter((p) => isCoarse(p.accuracy)).length;
	const tags: string[] = [];
	if (s.railLine) tags.push(`railLine=${s.railLine}`);
	if (s.snappedPath) tags.push(`snappedPath=${s.snappedPath.length}pts`);
	if (mode !== "stationary" && coarse >= 2 && !s.railLine) tags.push(`!! ${coarse} coarse fixes, no railLine`);
	const ctx = s.place ? `@ ${s.place}` : s.wayName ? `on ${s.wayName}` : "";
	console.log(
		`  ${fmt(s.startTs)}-${fmt(s.endTs)} ${mode.padEnd(11)} fixes:${inWin.length.toString().padStart(3)} coarse:${coarse.toString().padStart(3)} ${ctx} ${tags.join(" ")}`,
	);
}

// --- per train segment: re-run the snap lookup, stage by stage ----------
const trainSegs = segments.filter((s) => (s.refinedMode ?? s.mode) === "train");
console.log(`\n=== Train segments (${trainSegs.length}) — rail-snap stage trace ===`);
if (trainSegs.length === 0) console.log("  (none — nothing was classified as a train run today)");

for (const s of trainSegs) {
	console.log(`\n  ${fmt(s.startTs)}-${fmt(s.endTs)}  ${s.wayName ?? "(no wayName)"}`);
	const inWin = raw.filter((p) => p.ts >= s.startTs && p.ts <= s.endTs);
	const aq = quantiles(inWin.map((p) => p.accuracy ?? 0));
	// Fixes annotateSnappedPaths actually snaps: window minus the
	// positionally-useless (accuracy radius beyond the coarse ceiling).
	const fixes = inWin.filter((p) => p.accuracy == null || p.accuracy <= COARSE_ACCURACY_MAX_M);
	console.log(
		`    fixes: ${inWin.length} in window, ${inWin.length - fixes.length} dropped >${COARSE_ACCURACY_MAX_M}m  accuracy p50=${aq.p50.toFixed(0)}m p90=${aq.p90.toFixed(0)}m max=${aq.max.toFixed(0)}m  coarse=${inWin.filter((p) => isCoarse(p.accuracy)).length}`,
	);
	console.log(`    pipeline snappedPath: ${s.snappedPath ? `${s.snappedPath.length} pts` : "MISSING"}`);

	// Resolve the line the way annotateSnappedPaths does: railLine
	// field → wayName ` · ` suffix → mine from OSM at the endpoints.
	let line = s.railLine ?? parseRailLine(s.wayName);
	let lineSource = s.railLine ? "railLine field" : line ? "wayName suffix" : "";
	if (!line && fixes.length >= 2) {
		const good = fixes.filter((p) => p.accuracy == null || p.accuracy < COARSE_ACCURACY_M);
		const ends = good.length >= 2 ? good : fixes;
		const [a, b] = await Promise.all([
			linesAtPoint(ends[0].lat, ends[0].lon, 250),
			linesAtPoint(ends[ends.length - 1].lat, ends[ends.length - 1].lon, 250),
		]);
		const inter = [...a].filter((l) => b.has(l));
		console.log(`    mine: start{${[...a].join(", ")}}  end{${[...b].join(", ")}}  ∩{${inter.join(", ")}}`);
		line = inter[0] ?? null;
		if (line) lineSource = "mined";
	}
	if (!line) {
		console.log("    line: UNRESOLVED → not snapped (no railLine, no wayName suffix, empty mine).");
		continue;
	}
	console.log(`    line: ${line}  (${lineSource})`);
	if (fixes.length < 2) {
		console.log("    → too few usable fixes to snap.");
		continue;
	}

	// Corridor bbox — mirrors annotateSnappedPaths (600 m margin).
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLon = Infinity;
	let maxLon = -Infinity;
	for (const p of fixes) {
		minLat = Math.min(minLat, p.lat);
		maxLat = Math.max(maxLat, p.lat);
		minLon = Math.min(minLon, p.lon);
		maxLon = Math.max(maxLon, p.lon);
	}
	const dLat = 600 / 111_000;
	const dLon = 600 / (111_000 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
	const bbox = { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };

	const ways = await queryRouteGeometry(bbox, line);
	const vertexTotal = ways.reduce((n, w) => n + w.coords.length, 0);
	console.log(`    OSM geometry: ${ways.length} ways, ${vertexTotal} vertices in corridor`);
	if (ways.length === 0) {
		console.log(`    → STITCH SKIPPED: no osm_lines rows with name="${line}" in the corridor.`);
		console.log("    → likely cause: the OSM mirror has no named track geometry for this line.");
		continue;
	}

	// Stitch into components, then — as annotateSnappedPaths does —
	// score each by how well the fixes hug it and pick the best.
	const components = stitchWays(ways.map((w) => w.coords)).filter((c) => c.length >= 2);
	console.log(`    stitch: ${components.length} usable component(s) (of a possibly larger raw set)`);
	if (components.length === 0) {
		console.log("    → SNAP SKIPPED: nothing stitched into a usable polyline.");
		continue;
	}

	const medianOffset = (route: { lat: number; lon: number }[]): number => {
		const offs: number[] = [];
		for (const p of fixes) {
			const proj = projectOntoPolyline({ lat: p.lat, lon: p.lon }, route);
			if (proj) offs.push(proj.offsetM);
		}
		return quantiles(offs).p50;
	};
	const scored = components
		.map((c) => {
			let len = 0;
			for (let i = 1; i < c.length; i++) len += meters(c[i - 1].lat, c[i - 1].lon, c[i].lat, c[i].lon);
			return { c, len, med: medianOffset(c) };
		})
		.sort((a, b) => a.med - b.med);
	for (const s2 of scored.slice(0, 5)) {
		console.log(
			`      component: ${s2.c.length.toString().padStart(4)} vertices, ${(s2.len / 1000).toFixed(2).padStart(6)} km, median fix-offset ${s2.med.toFixed(0)}m`,
		);
	}
	const best = scored[0];
	if (best.med > 600) {
		console.log(`    → ROUTE-FIT GUARD: best component median offset ${best.med.toFixed(0)}m > 600m — snap rejected.`);
		continue;
	}

	const snapped = snapFixesToRoute(
		fixes.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon })),
		best.c,
	);
	console.log(
		`    chosen component median offset ${best.med.toFixed(0)}m → snapFixesToRoute → ${snapped.length} points`,
	);
	console.log(
		snapped.length >= 2
			? "    → snapped OK."
			: "    → SNAP PRODUCED <2 POINTS: fixes did not map-match onto the route.",
	);
}

process.exit(0);
