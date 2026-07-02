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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isEnforceableTruth, parseGroundTruth } from "../eval/ground-truth.js";
import { buildingCrossingM } from "../eval/walk-buildings.js";
import { walkPlausibility } from "../eval/walk-plausibility.js";
import { onNamedWayFraction } from "../eval/walk-route-correctness.js";
import { FixtureOsmAdapter } from "../geo/osm-adapter-fixture.js";
import type { BuildingFootprint } from "../geo/osm-local.js";
import type { OsmRoadWay, RoadGeometry } from "../geo/road-match.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import {
	countSharpTurns,
	type MapSmoothProfile,
	REFINE_MATCHED_PROFILE,
	refineMatchedPath,
	type WalkFix,
} from "../geo/walk-smooth-map.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

/** Refine profile with env overrides, so the σ balance can be swept without a
 *  rebuild: REFINE_SMOOTH_SIGMA / REFINE_NET_SIGMA / REFINE_GPS_SIGMA (metres). */
function refineProfileFromEnv(): MapSmoothProfile {
	const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
	return {
		...REFINE_MATCHED_PROFILE,
		gpsSigmaFallbackM: num(process.env.REFINE_GPS_SIGMA, REFINE_MATCHED_PROFILE.gpsSigmaFallbackM),
		smoothSigmaM: num(process.env.REFINE_SMOOTH_SIGMA, REFINE_MATCHED_PROFILE.smoothSigmaM),
		networkSigmaM: num(process.env.REFINE_NET_SIGMA, REFINE_MATCHED_PROFILE.networkSigmaM),
	};
}
const REFINE_PROFILE = refineProfileFromEnv();

/** A confirmed street name and the window it applies to, from the day's
 *  ground-truth narrative — only enforceable "walking on <way>" rows. This is
 *  the truth signal the geometric proxies lack: it names the street a leg ran
 *  along, so the drawn line can be scored by NAME, not geometry. */
interface NamedWalkWindow {
	startTs: number;
	endTs: number;
	name: string;
}

/** Load the enforceable named walk windows for a day, or [] when the day has no
 *  ground-truth file or no confirmed street-named walk rows. */
function loadNamedWalkWindows(date: string, tz: string): NamedWalkWindow[] {
	const path = `tests/golden/ground-truth/${date}.md`;
	if (!existsSync(path)) return [];
	const gt = parseGroundTruth(readFileSync(path, "utf8"), date, tz);
	const out: NamedWalkWindow[] = [];
	for (const row of gt.rows) {
		if (row.blessed?.mode !== "walking" || !row.blessed.wayName) continue;
		if (!isEnforceableTruth(row)) continue;
		out.push({ startTs: row.startTs, endTs: row.endTs, name: row.blessed.wayName });
	}
	return out;
}

/** Accepted street names for an episode: the names of every named walk window
 *  that overlaps the episode's time span. Empty when the day's narrative names
 *  no street over this leg (→ route-correctness is left null, not scored). */
function acceptedNamesForEpisode(windows: readonly NamedWalkWindow[], startTs: number, endTs: number): Set<string> {
	const names = new Set<string>();
	for (const w of windows) if (w.endTs > startTs && w.startTs < endTs) names.add(w.name);
	return names;
}

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

/** Every building footprint anywhere in the captured trace — the impassable
 *  layer the building-crossing metric scores against, flattened across all query
 *  keys. `undefined` section = fixture captured before the buildings field →
 *  "no building data" (the metric is left null, not scored as 0). */
function allBuildings(captured: CapturedDay): BuildingFootprint[] {
	const section = captured.inputs.osmTrace.buildingsNear;
	if (section === undefined) return [];
	const out: BuildingFootprint[] = [];
	for (const rings of Object.values(section)) out.push(...rings);
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
	/** Truth-anchored route-correctness: fraction of the drawn line running along
	 *  the ground-truth-confirmed street, baseline vs candidate. null when the
	 *  day's narrative names no street over this leg. A drop from baseline→candidate
	 *  is the invented-detour signal off-walkable-p90 rewards. */
	baselineRouteCorr: number | null;
	candidateRouteCorr: number | null;
	/** Sharp-turn (~90° staircase) count of the CURRENT drawn line — the de-boxing
	 *  witness off-walkable is blind to. */
	candidateSharpTurns: number;
	/** Building-crossing length (m) of the drawn line — the headline defect the
	 *  off-walkable proxy is blind to. baseline (smoother) vs candidate (matched).
	 *  null when the fixture carries no building data. */
	baselineBuildingM: number | null;
	candidateBuildingM: number | null;
	/** The matched-line REFINEMENT arm (Phase 1, both-staged) — the continuous
	 *  smoother run over the matched line as its own corridor, rounding the boxy
	 *  corners toward the raw GPS. null when it bailed. Its off-walkable p90,
	 *  stall, route-correctness, and sharp-turn count for the head-to-head. */
	refineP90: number | null;
	refineStallM: number | null;
	refineRouteCorr: number | null;
	refineSharpTurns: number | null;
	refineBuildingM: number | null;
}

/** How far the candidate's route-correctness may fall below baseline before it
 *  counts as a route regression — i.e. the candidate drew a meaningfully larger
 *  share of the line onto a street the ground truth does not confirm. */
const ROUTE_CORR_EPS = 0.1;

/** A route regression: the candidate moved > `ROUTE_CORR_EPS` of the drawn line
 *  off the confirmed street(s). The invented-detour class caught by NAME. */
function routeRegressed(v: WalkVerdict): boolean {
	if (v.baselineRouteCorr === null || v.candidateRouteCorr === null) return false;
	return v.candidateRouteCorr < v.baselineRouteCorr - ROUTE_CORR_EPS;
}

/** A drawn walk above this mean speed (km/h) is physically implausible on foot —
 *  the signature of low-accuracy fixes drawn as real motion. */
const WALK_SPEED_CEIL_KMH = 12;

async function scoreDay(date: string, user: string): Promise<WalkVerdict[]> {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${user}.json`, "utf8"));
	const walkable: RoadGeometry = { ways: allWalkable(captured) };
	const buildings = allBuildings(captured);
	// "Has building data" means actual footprint geometry, not an empty stub. The
	// live pipeline does not query buildingsNear, so today every fixture's section
	// is present-but-empty — the metric is left null (honestly "unmeasured"), NOT
	// reported as a clean 0, until building geometry is captured.
	const hasBuildings = buildings.length > 0;
	const crossM = (pts: readonly { lat: number; lon: number }[]): number | null =>
		hasBuildings ? buildingCrossingM(pts, buildings) : null;
	const namedWindows = loadNamedWalkWindows(date, captured.meta.tz);
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
		const accepted = acceptedNamesForEpisode(namedWindows, onE.startTs, onE.endTs);
		const candidateRouteCorr =
			accepted.size > 0
				? onNamedWayFraction(
						onE.points.map((p) => ({ lat: p.lat, lon: p.lon })),
						accepted,
						walkable,
					)
				: null;
		const baselineRouteCorr =
			accepted.size > 0 && offE && offE.points.length >= 2
				? onNamedWayFraction(
						offE.points.map((p) => ({ lat: p.lat, lon: p.lon })),
						accepted,
						walkable,
					)
				: null;

		// The matched-line REFINEMENT arm — round the current matched line toward
		// the raw GPS, using the matched line as its own corridor. Measures the
		// Phase-1 algorithm directly, independent of pipeline wiring.
		const rawWalk: WalkFix[] = on.rawFixes
			.filter((f) => f.ts >= onE.startTs && f.ts <= onE.endTs)
			.map((f) => ({ lat: f.lat, lon: f.lon, ts: f.ts, accuracyM: f.accuracy ?? undefined }));
		const candidatePoints = onE.points.map((p) => ({ lat: p.lat, lon: p.lon }));
		const refined = refineMatchedPath(rawWalk, candidatePoints, REFINE_PROFILE);
		const refine = refined
			? walkPlausibility(
					raw,
					refined.map((p) => ({ lat: p.lat, lon: p.lon })),
					onE.startTs,
					onE.endTs,
					[],
					walkable,
				)
			: null;
		const refineRouteCorr =
			refined && accepted.size > 0
				? onNamedWayFraction(
						refined.map((p) => ({ lat: p.lat, lon: p.lon })),
						accepted,
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
			baselineRouteCorr,
			candidateRouteCorr,
			candidateSharpTurns: countSharpTurns(candidatePoints),
			baselineBuildingM: offE && offE.points.length >= 2 ? crossM(offE.points) : null,
			candidateBuildingM: crossM(candidatePoints),
			refineP90: refine?.offWalkableP90M ?? null,
			refineStallM: refine?.corridorStallM ?? null,
			refineRouteCorr,
			refineSharpTurns: refined ? countSharpTurns(refined.map((p) => ({ lat: p.lat, lon: p.lon }))) : null,
			refineBuildingM: refined ? crossM(refined.map((p) => ({ lat: p.lat, lon: p.lon }))) : null,
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
			const route =
				v.baselineRouteCorr === null || v.candidateRouteCorr === null
					? ""
					: `  route ${(v.baselineRouteCorr * 100).toFixed(0)}%→${(v.candidateRouteCorr * 100).toFixed(0)}%${routeRegressed(v) ? " ⚠route-regress" : ""}`;
			const bldg =
				v.candidateBuildingM === null
					? ""
					: `  bldg ${(v.baselineBuildingM ?? 0).toFixed(0)}→${v.candidateBuildingM.toFixed(0)}m${v.candidateBuildingM >= 5 ? " ⚠crosses-building" : ""}`;
			console.log(
				`  ${tag} @${hhmm(v.startTs)}Z  offWalkP90 ${b} → ${c}  stall ${v.candidateStallM.toFixed(0).padStart(4)}m${stallFlag}  ${spd.toFixed(1).padStart(5)}km/h${spdFlag}${route}${bldg}   (${v.baselineKind} → ${v.candidateKind})`,
			);
			if (v.refineP90 !== null) {
				const sp90 = `${v.refineP90.toFixed(0).padStart(3)}m`;
				const sroute =
					v.refineRouteCorr === null || v.candidateRouteCorr === null
						? ""
						: `  route ${(v.candidateRouteCorr * 100).toFixed(0)}%→${(v.refineRouteCorr * 100).toFixed(0)}%`;
				console.log(
					`      └ MAP-refine  offWalkP90 ${sp90}  stall ${(v.refineStallM ?? 0).toFixed(0).padStart(4)}m  turns ${v.candidateSharpTurns}→${v.refineSharpTurns ?? "-"}${sroute}`,
				);
			}
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
	// Truth-anchored route-correctness — the honest gate the off-walkable proxy
	// cannot be. Reported over the legs the narratives name a street for.
	const routed = all.filter((v) => v.candidateRouteCorr !== null);
	const routeRegressions = all.filter(routeRegressed);
	const meanRouteCorr =
		routed.length > 0 ? routed.reduce((s, v) => s + (v.candidateRouteCorr ?? 0), 0) / routed.length : null;
	console.log(
		`ROUTE-CORRECTNESS: ${routed.length} walk(s) with a named-street truth; mean on-street ${
			meanRouteCorr === null ? "n/a" : `${(meanRouteCorr * 100).toFixed(0)}%`
		}; route-regressed ${routeRegressions.length}`,
	);
	for (const v of routeRegressions) {
		console.log(
			`  ${v.date} @${hhmm(v.startTs)}Z  ${((v.baselineRouteCorr ?? 0) * 100).toFixed(0)}% → ${((v.candidateRouteCorr ?? 0) * 100).toFixed(0)}% on confirmed street`,
		);
	}

	// Building-crossing — the headline defect off-walkable-p90 is blind to. This is
	// the measurement baseline: how many walks the CURRENT drawn line runs through a
	// building today, and whether the refinement arm reduces it. Reported, not yet
	// gated (the current Viterbi+matched line is what crosses; driving it to 0 is
	// the Phase-1 target).
	const withB = all.filter((v) => v.candidateBuildingM !== null);
	const CROSS_M = 5;
	const candCross = withB.filter((v) => (v.candidateBuildingM ?? 0) >= CROSS_M);
	const refCross = withB.filter((v) => v.refineBuildingM !== null && (v.refineBuildingM ?? 0) >= CROSS_M);
	console.log(
		`\nBUILDING-CROSSING (${withB.length} walks with building data): ` +
			`current draw crosses a building on ${candCross.length}; refine arm on ${refCross.length}`,
	);
	for (const v of candCross.sort((a, b) => (b.candidateBuildingM ?? 0) - (a.candidateBuildingM ?? 0))) {
		const r = v.refineBuildingM === null ? "-" : `${v.refineBuildingM.toFixed(0)}m`;
		console.log(
			`  ${v.date} @${hhmm(v.startTs)}Z  ${(v.candidateBuildingM ?? 0).toFixed(0)}m through buildings (refine ${r})`,
		);
	}

	// Phase-1 head-to-head: the matched-line REFINEMENT vs the CURRENT drawn line.
	// Headline witness is SHARP TURNS — the refinement's job is to remove the boxy
	// ~90° graph corners WITHOUT worsening off-walkable / stall / route.
	const ref = all.filter((v) => v.refineP90 !== null && v.candidateP90 !== null);
	const p90Worse = ref.filter((v) => (v.refineP90 ?? 0) > (v.candidateP90 ?? 0) + 3).length;
	const stallWorse = ref.filter((v) => (v.refineStallM ?? 0) > v.candidateStallM + 15).length;
	const turnsBetter = ref.filter((v) => (v.refineSharpTurns ?? 0) < v.candidateSharpTurns).length;
	const turnsWorse = ref.filter((v) => (v.refineSharpTurns ?? 0) > v.candidateSharpTurns).length;
	const routedBoth = ref.filter((v) => v.refineRouteCorr !== null && v.candidateRouteCorr !== null);
	const routeWorse = routedBoth.filter((v) => (v.refineRouteCorr ?? 0) < (v.candidateRouteCorr ?? 0) - 0.05).length;
	const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
	console.log(
		`\nMAP-REFINE vs CURRENT (${ref.length} walks): ` +
			`sharpTurns mean ${mean(ref.map((v) => v.candidateSharpTurns)).toFixed(1)}→${mean(ref.map((v) => v.refineSharpTurns ?? 0)).toFixed(1)} (better ${turnsBetter}, worse ${turnsWorse}); ` +
			`offWalkP90 mean ${mean(ref.map((v) => v.candidateP90 ?? 0)).toFixed(1)}m→${mean(ref.map((v) => v.refineP90 ?? 0)).toFixed(1)}m (worse-by>3m ${p90Worse}); ` +
			`stall worse-by>15m ${stallWorse}; route worse-by>5% ${routeWorse}`,
	);

	// The production gate: apply the refinement ONLY where it actually reduces
	// sharp turns (the clamp already bounds faithfulness). Report what the gated
	// choice costs on the other witnesses — this is the real shipping impact.
	const applied = ref.filter((v) => (v.refineSharpTurns ?? 999) < v.candidateSharpTurns);
	const aStallWorse = applied.filter((v) => (v.refineStallM ?? 0) > v.candidateStallM + 15).length;
	const aOffWorse = applied.filter((v) => (v.refineP90 ?? 0) > (v.candidateP90 ?? 0) + 5).length;
	const aRouteWorse = applied.filter(
		(v) => v.refineRouteCorr !== null && (v.refineRouteCorr ?? 0) < (v.candidateRouteCorr ?? 0) - 0.05,
	).length;
	const aTurnsDrop = mean(applied.map((v) => v.candidateSharpTurns - (v.refineSharpTurns ?? 0)));
	console.log(
		`GATED (apply only where sharpTurns drop): ${applied.length}/${ref.length} walks refined, ` +
			`mean −${aTurnsDrop.toFixed(1)} sharp turns each; of those stall-worse>15m ${aStallWorse}, ` +
			`offWalk-worse>5m ${aOffWorse}, route-worse>5% ${aRouteWorse}`,
	);

	// Non-zero exit if any walk regressed on EITHER witness — the ship gate.
	process.exit(regressed > 0 || routeRegressions.length > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
