/**
 * CLI: the deterministic referee for pedestrian map-matching
 * (`docs/proposals/2026-06-map-constrained-positioning.md`, #265/#271).
 *
 * Replays a captured golden fixture TWICE through the pure pipeline — once with
 * the walk-matcher off (`walkMatch:false` → walks resolve to the smoother) and
 * once on (the matched line where the gate fires) — and, per walking episode,
 * reports the off-walkable p90 of the drawn line in each arm. A walk is an
 * IMPROVEMENT when the candidate p90 drops, a REGRESSION when it rises, and
 * NEUTRAL when the matcher bailed (the line is unchanged).
 *
 * Zero DB, zero Overpass: the off-walkable distance is measured against the
 * fixture's own flattened `walkableRoads` trace, so no new OSM query is issued
 * and the verdict is a pure-function replay.
 *
 *   node dist/cli/score-walk-match.js              # sweep every golden day
 *   node dist/cli/score-walk-match.js 2026-06-24   # one day (pippijn)
 */

import { readdirSync, readFileSync } from "node:fs";
import { walkPlausibility } from "../eval/walk-plausibility.js";
import { FixtureOsmAdapter } from "../geo/osm-adapter-fixture.js";
import type { OsmRoadWay, RoadGeometry } from "../geo/road-match.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

/** Every walkable way anywhere in the captured trace — the universe the drawn
 *  line is scored against, flattened across all query keys. `undefined` section
 *  = fixture captured before the walkable field; treat as "no walkable data"
 *  (no matching possible). */
function allWalkable(captured: CapturedDay): OsmRoadWay[] {
	const section = captured.inputs.osmTrace.walkableRoads;
	if (section === undefined) return [];
	const out: OsmRoadWay[] = [];
	for (const ways of Object.values(section)) out.push(...ways);
	return out;
}

function hhmm(ts: number): string {
	return new Date(ts * 1000).toISOString().slice(11, 16);
}

interface WalkVerdict {
	date: string;
	startTs: number;
	baselineKind: string;
	candidateKind: string;
	baselineP90: number | null;
	candidateP90: number | null;
	/** Raw-vs-matched over-route metric on the drawn candidate line (m). */
	candidateStallM: number;
	/** Mean walking speed the drawn candidate line implies (km/h). Flags the
	 *  underground/indoor teleport class the off-walkable p90 is blind to. */
	candidateSpeedKmh: number;
}

/** A drawn walk above this mean speed (km/h) is physically implausible on foot —
 *  the signature of low-accuracy fixes drawn as real motion. */
const WALK_SPEED_CEIL_KMH = 12;

async function scoreDay(date: string, user: string): Promise<WalkVerdict[]> {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${user}.json`, "utf8"));
	const walkable: RoadGeometry = { ways: allWalkable(captured) };
	const base = inputsFromFixture(captured);

	// Fresh adapter per arm (stateless, but explicit).
	const offInputs = { ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) };
	const onInputs = { ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) };
	const off = await computeVelocityFromInputs(offInputs, { walkMatch: false });
	const on = await computeVelocityFromInputs(onInputs, { walkMatch: true });

	// walkMatch only changes drawn geometry, not segmentation, so the episode
	// lists align by index. Score only walking legs with a drawable line.
	const verdicts: WalkVerdict[] = [];
	for (let i = 0; i < on.episodes.length; i++) {
		const onE = on.episodes[i];
		const offE = off.episodes[i];
		if (onE.mode !== "walking" || onE.points.length < 2) continue;
		// The raw GPS corridor the drawn line is measured against — needed for the
		// over-route (corridor-stall) witness `scoreWalk` alone cannot see.
		const raw = on.rawFixes
			.filter((f) => f.ts >= onE.startTs && f.ts <= onE.endTs)
			.map((f) => ({ lat: f.lat, lon: f.lon }));
		const candidate = walkPlausibility(
			raw,
			onE.points.map((p) => ({ lat: p.lat, lon: p.lon })),
			onE.startTs,
			onE.endTs,
			[],
			walkable,
		);
		const baseline =
			offE && offE.points.length >= 2
				? walkPlausibility(
						raw,
						offE.points.map((p) => ({ lat: p.lat, lon: p.lon })),
						offE.startTs,
						offE.endTs,
						[],
						walkable,
					)
				: null;
		verdicts.push({
			date,
			startTs: onE.startTs,
			baselineKind: offE?.kind ?? "(none)",
			candidateKind: onE.kind,
			baselineP90: baseline?.offWalkableP90M ?? null,
			candidateP90: candidate.offWalkableP90M,
			candidateStallM: candidate.corridorStallM,
			candidateSpeedKmh: candidate.avgDrawnSpeedKmh,
		});
	}
	return verdicts;
}

function classify(v: WalkVerdict): "improved" | "regressed" | "neutral" | "n/a" {
	if (v.baselineP90 === null || v.candidateP90 === null) return "n/a";
	const delta = v.candidateP90 - v.baselineP90;
	if (delta < -0.5) return "improved";
	if (delta > 0.5) return "regressed";
	return "neutral";
}

async function main(): Promise<void> {
	const user = "pippijn";
	const arg = process.argv[2];
	const dates = arg
		? [arg]
		: readdirSync("tests/golden/days")
				.filter((f) => f.endsWith(`-${user}.json`))
				.map((f) => f.slice(0, 10))
				.sort();

	const all: WalkVerdict[] = [];
	for (const date of dates) {
		const verdicts = await scoreDay(date, user);
		all.push(...verdicts);
		if (verdicts.length === 0) {
			console.log(`${date}: no walking legs`);
			continue;
		}
		console.log(`${date}: ${verdicts.length} walk(s)`);
		for (const v of verdicts) {
			const tag = classify(v).toUpperCase().padEnd(9);
			const b = v.baselineP90 === null ? "  -" : `${v.baselineP90.toFixed(0).padStart(3)}m`;
			const c = v.candidateP90 === null ? "  -" : `${v.candidateP90.toFixed(0).padStart(3)}m`;
			const stallFlag = v.candidateStallM >= 80 ? " ⚠over-route" : "";
			const spd = v.candidateSpeedKmh;
			const spdFlag = spd > WALK_SPEED_CEIL_KMH ? " ⚠impossible-walk" : "";
			console.log(
				`  ${tag} @${hhmm(v.startTs)}Z  offWalkP90 ${b} → ${c}  stall ${v.candidateStallM.toFixed(0).padStart(4)}m${stallFlag}  ${spd.toFixed(1).padStart(5)}km/h${spdFlag}   (${v.baselineKind} → ${v.candidateKind})`,
			);
		}
	}

	const improved = all.filter((v) => classify(v) === "improved").length;
	const regressed = all.filter((v) => classify(v) === "regressed").length;
	const neutral = all.filter((v) => classify(v) === "neutral" || classify(v) === "n/a").length;
	const impossible = all.filter((v) => v.candidateSpeedKmh > WALK_SPEED_CEIL_KMH);
	console.log(`\nSUMMARY: ${all.length} walks — improved ${improved}, regressed ${regressed}, neutral ${neutral}`);
	console.log(
		`PLAUSIBILITY: ${impossible.length} walk(s) drawn above ${WALK_SPEED_CEIL_KMH} km/h (implausible on foot)`,
	);
	for (const v of impossible.sort((a, b) => b.candidateSpeedKmh - a.candidateSpeedKmh)) {
		console.log(`  ${v.date} @${hhmm(v.startTs)}Z  ${v.candidateSpeedKmh.toFixed(1)} km/h  (${v.candidateKind})`);
	}
	if (regressed > 0) {
		console.log("REGRESSIONS:");
		for (const v of all.filter((x) => classify(x) === "regressed")) {
			console.log(`  ${v.date} @${hhmm(v.startTs)}Z  ${v.baselineP90?.toFixed(0)}m → ${v.candidateP90?.toFixed(0)}m`);
		}
	}
	// Non-zero exit if any walk regressed — usable as a ship gate.
	process.exit(regressed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
