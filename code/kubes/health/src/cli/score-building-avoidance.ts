/**
 * CLI: measure whether the smoothed walking lines on a captured golden day
 * stay OUT of building footprints — the verdict for the walkable-surface field
 * (`docs/design/episode-geometry.md`, "real
 * walkable-surface field").
 *
 * Replays a deterministic fixture twice — once with the captured building
 * footprints fed to the smoother, once with them suppressed — and for every
 * smoothed walking episode counts how many vertices fall inside a building. The
 * building term works iff the count drops with buildings on. Zero DB, zero
 * Overpass: pure replay off `tests/golden/days/<date>-<user>.json`.
 *
 *   node dist/cli/score-building-avoidance.js 2026-06-22 pippijn
 */

import { readFileSync } from "node:fs";
import type { OsmAdapter } from "../geo/osm-adapter.js";
import { FixtureOsmAdapter } from "../geo/osm-adapter-fixture.js";
import type { BuildingFootprint } from "../geo/osm-local.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

const [date, user] = process.argv.slice(2);
if (!date || !user) {
	console.error("Usage: node dist/cli/score-building-avoidance.js <date> <user>");
	process.exit(2);
}

/** All building footprints anywhere in the captured trace — the universe the
 *  rendered line must avoid (the adapter only ever returns a subset per query,
 *  but a vertex inside ANY of them is "through a building"). */
function allBuildings(captured: CapturedDay): BuildingFootprint[] {
	const section = captured.inputs.osmTrace.buildingsNear ?? {};
	const out: BuildingFootprint[] = [];
	for (const rings of Object.values(section)) out.push(...rings);
	return out;
}

/** Ray-cast point-in-polygon on a lat/lon ring. */
function inRing(lat: number, lon: number, ring: BuildingFootprint): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const yi = ring[i].lat;
		const xi = ring[i].lon;
		const yj = ring[j].lat;
		const xj = ring[j].lon;
		const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (hit) inside = !inside;
	}
	return inside;
}

function countInBuildings(pts: ReadonlyArray<{ lat: number; lon: number }>, buildings: BuildingFootprint[]): number {
	let n = 0;
	for (const p of pts) if (buildings.some((b) => inRing(p.lat, p.lon, b))) n++;
	return n;
}

/** Wrap an adapter so buildingsNear returns nothing — the "buildings off" arm.
 *  Delegates every other method to `inner` (a class instance, so a plain spread
 *  would drop its prototype methods). */
function withoutBuildings(inner: OsmAdapter): OsmAdapter {
	return {
		nearbyWays: (...a) => inner.nearbyWays(...a),
		nearbyStations: (...a) => inner.nearbyStations(...a),
		nearbyLandmarks: (...a) => inner.nearbyLandmarks(...a),
		linesAtPoint: (...a) => inner.linesAtPoint(...a),
		reverseGeocode: (...a) => inner.reverseGeocode(...a),
		nearbyTransitStops: (...a) => inner.nearbyTransitStops(...a),
		stationsOnLine: (...a) => inner.stationsOnLine(...a),
		drivableRoads: (...a) => inner.drivableRoads(...a),
		walkableRoads: (...a) => inner.walkableRoads(...a),
		buildingsNear: async () => [],
	};
}

async function main(): Promise<void> {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${user}.json`, "utf8"));
	const buildings = allBuildings(captured);
	console.log(`${date} ${user}: ${buildings.length} captured building footprints\n`);

	const base = inputsFromFixture(captured);
	// Rebuild a fresh FixtureOsmAdapter for each arm (stateless, but explicit).
	const onInputs = { ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) };
	const offInputs = { ...base, osm: withoutBuildings(new FixtureOsmAdapter(captured.inputs.osmTrace)) };

	const on = await computeVelocityFromInputs(onInputs);
	const off = await computeVelocityFromInputs(offInputs);

	const offEpisodes = off.episodes;
	const onEpisodes = on.episodes;

	const fmt = (n: number): string => n.toString().padStart(2);
	let totalOn = 0;
	let totalOff = 0;
	for (let i = 0; i < onEpisodes.length; i++) {
		const e = onEpisodes[i];
		if (e.kind !== "smoothed") continue;
		const offE = offEpisodes[i];
		const onIn = countInBuildings(e.points, buildings);
		const offIn = offE ? countInBuildings(offE.points, buildings) : 0;
		totalOn += onIn;
		totalOff += offIn;
		const hhmm = new Date(e.startTs * 1000).toISOString().slice(11, 16);
		console.log(
			`smoothed walk ${i} @${hhmm}Z (${e.points.length} pts): in-building off=${fmt(offIn)} → on=${fmt(onIn)}`,
		);
	}
	console.log(`\nTOTAL smoothed vertices in buildings: off=${totalOff} → on=${totalOn}`);
}

main().then(
	() => process.exit(0),
	(e) => {
		console.error(e);
		process.exit(1);
	},
);
