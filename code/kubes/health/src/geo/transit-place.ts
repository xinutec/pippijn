import type { OsmAdapter } from "./osm-adapter.js";

/** "You are at the station" footprint: how close a train-alighting stay
 *  must sit to a station node before we name the stay after it. Tight
 *  enough that a café you genuinely walked to (with a walking segment in
 *  between, which also disqualifies it) isn't swallowed by the station. */
export const STATION_AT_ALIGHT_RADIUS_M = 150;

/**
 * Transit continuity for place-naming. A stationary stay immediately
 * preceded by a train, sitting within station range, is at the station
 * the user just alighted at — not at a co-located café the place-picker
 * would otherwise latch onto. Returns the nearest station's name, or
 * null when the preceding segment isn't a train or no station is close
 * enough.
 *
 * Motivated by 2026-05-22: an ambulance wait on the Finchley Road
 * station forecourt (alighted a train, then stood still) was mislabelled
 * "Loft Coffee Company" because the place-picker never consults stations
 * and had no transit context. The immediately-preceding train is the
 * disambiguator — a genuine café visit has a walking segment between the
 * alight and the stay, so `prev` would be walking, not train.
 */
export async function stationAtTrainAlight(
	prev: { mode: string; refinedMode?: string } | undefined,
	lat: number,
	lon: number,
	osm: Pick<OsmAdapter, "nearbyStations">,
	radiusM: number = STATION_AT_ALIGHT_RADIUS_M,
): Promise<string | null> {
	if (prev === undefined) return null;
	if ((prev.refinedMode ?? prev.mode) !== "train") return null;
	const stations = await osm.nearbyStations(lat, lon, radiusM);
	if (stations.length === 0) return null;
	const nearest = stations.reduce((a, b) => (b.distanceM < a.distanceM ? b : a));
	return nearest.distanceM <= radiusM ? nearest.name : null;
}
