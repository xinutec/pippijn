/**
 * OpenStreetMap enrichment for transport segments.
 *
 * - Stationary segments: reverse-geocode the centroid via Nominatim to get place name/type
 * - Moving segments: query Overpass for nearby ways (highway, railway, etc.) to refine the mode
 *
 * Results cached in MariaDB (osm_cache table) keyed by rounded coordinates.
 * Cache hits avoid network entirely — page loads go from seconds to ms.
 */

import { db } from "../db/pool.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "health.xinutec.org (pippijn@xinutec.org)";

// Round to 4 decimals = ~11m precision for cache key
function roundCoord(n: number): number {
	return Math.round(n * 10000) / 10000;
}

async function cacheGet<T>(queryType: string, lat: number, lon: number): Promise<T | undefined> {
	const row = await db()
		.selectFrom("osm_cache")
		.select("result")
		.where("query_type", "=", queryType)
		.where("lat_rounded", "=", roundCoord(lat))
		.where("lon_rounded", "=", roundCoord(lon))
		.executeTakeFirst();
	return row ? (JSON.parse(row.result) as T) : undefined;
}

async function cacheSet(queryType: string, lat: number, lon: number, value: unknown): Promise<void> {
	await db()
		.insertInto("osm_cache")
		.values({
			query_type: queryType,
			lat_rounded: roundCoord(lat),
			lon_rounded: roundCoord(lon),
			result: JSON.stringify(value),
		})
		.onDuplicateKeyUpdate({ result: JSON.stringify(value) })
		.execute();
}

// --- Nominatim reverse geocoding ---

export interface NominatimResult {
	displayName: string;
	type: string; // e.g. "restaurant", "cafe", "park", "residential", "square"
	category: string; // top-level category, e.g. "amenity", "leisure", "building", "place"
	address: {
		amenity?: string;
		tourism?: string; // "hotel", "museum", etc.
		leisure?: string; // "park", "playground", etc.
		shop?: string; // "supermarket", "bakery", etc.
		building?: string;
		road?: string;
		pedestrian?: string; // square / pedestrian street name
		neighbourhood?: string;
		suburb?: string;
		city?: string;
		state?: string;
		country?: string;
		postcode?: string;
	};
}

interface NominatimResponse {
	display_name?: string;
	type?: string;
	category?: string;
	class?: string;
	address?: NominatimResult["address"];
}

export async function reverseGeocode(lat: number, lon: number, zoom = 18): Promise<NominatimResult | null> {
	const cacheType = `nominatim_z${zoom}`;
	const cached = await cacheGet<NominatimResult | null>(cacheType, lat, lon);
	if (cached !== undefined) return cached;

	const url = new URL(NOMINATIM_URL);
	url.searchParams.set("lat", lat.toString());
	url.searchParams.set("lon", lon.toString());
	url.searchParams.set("format", "json");
	url.searchParams.set("zoom", zoom.toString());

	const res = await fetch(url.toString(), {
		headers: { "User-Agent": USER_AGENT },
	});

	if (!res.ok) {
		console.warn(`Nominatim returned ${res.status} for ${lat},${lon}`);
		return null;
	}

	const data = (await res.json()) as NominatimResponse;
	if (!data.display_name) {
		await cacheSet(cacheType, lat, lon, null);
		return null;
	}

	const result: NominatimResult = {
		displayName: data.display_name,
		type: data.type ?? "",
		category: data.class ?? data.category ?? "",
		address: data.address ?? {},
	};
	await cacheSet(cacheType, lat, lon, result);
	return result;
}

/**
 * Look up a stationary place. Strategy:
 *
 * 1. Detailed building-level Nominatim (zoom 18) — catches venues with addresses
 *    (Brasserie Vermeer, Hotel X). Use it directly if it returns a specific venue.
 * 2. If the building lookup is just a residential address, query Overpass for
 *    named landmarks (amenity/tourism/leisure/shop/place/named pedestrian area)
 *    within 100 m. The GPS centroid often lands on a residential building next
 *    door to a square/park/plaza; this surfaces the landmark instead.
 * 3. Area-level Nominatim (zoom 16) as a softer fallback for places where the
 *    landmark is only known to Nominatim.
 * 4. Last resort: return the residential address from step 1.
 */
export async function bestPlace(lat: number, lon: number): Promise<NominatimResult | null> {
	const detailed = await reverseGeocode(lat, lon, 18);
	if (detailed && hasSpecificVenue(detailed)) return detailed;

	const landmarks = await nearbyLandmarks(lat, lon, 100);
	if (landmarks.length > 0) {
		return landmarkToResult(pickBestLandmark(landmarks));
	}

	const area = await reverseGeocode(lat, lon, 16);
	if (area && (hasSpecificVenue(area) || isLandmark(area))) return area;
	return detailed ?? area;
}

function hasSpecificVenue(r: NominatimResult): boolean {
	const a = r.address;
	return !!(a.amenity || a.tourism || a.leisure || a.shop);
}

function isLandmark(r: NominatimResult): boolean {
	// Squares, parks, plazas, named pedestrian areas — useful even without a venue
	return r.category === "place" || r.category === "leisure" || !!r.address.pedestrian;
}

// --- Overpass: nearby named landmarks ---

export interface NearbyLandmark {
	name: string;
	type: "amenity" | "tourism" | "leisure" | "shop" | "place" | "highway";
	subtype: string; // "restaurant", "park", "square", "pedestrian", etc.
	distanceM: number;
}

const LANDMARK_PRIORITY: Record<NearbyLandmark["type"], number> = {
	amenity: 5,
	tourism: 5,
	shop: 4,
	leisure: 4,
	place: 3,
	highway: 1,
};

export function pickBestLandmark(landmarks: NearbyLandmark[]): NearbyLandmark {
	return [...landmarks].sort((a, b) => {
		const pa = LANDMARK_PRIORITY[a.type];
		const pb = LANDMARK_PRIORITY[b.type];
		if (pa !== pb) return pb - pa;
		return a.distanceM - b.distanceM;
	})[0];
}

export function landmarkToResult(l: NearbyLandmark): NominatimResult {
	const address: NominatimResult["address"] = {};
	if (l.type === "amenity") address.amenity = l.name;
	else if (l.type === "tourism") address.tourism = l.name;
	else if (l.type === "leisure") address.leisure = l.name;
	else if (l.type === "shop") address.shop = l.name;
	else address.pedestrian = l.name; // place, highway=pedestrian
	return {
		displayName: l.name,
		type: l.subtype,
		category: l.type,
		address,
	};
}

function landmarkHaversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface OverpassElement {
	lat?: number;
	lon?: number;
	center?: { lat: number; lon: number };
	tags?: Record<string, string>;
}

/**
 * Find named landmarks (squares, parks, restaurants, museums, etc.) near a
 * point. Used to label stationary stays when the centroid lands on a generic
 * residential building adjacent to the actual landmark.
 */
export async function nearbyLandmarks(lat: number, lon: number, radiusM = 100): Promise<NearbyLandmark[]> {
	const cacheType = `landmarks_r${radiusM}`;
	const cached = await cacheGet<NearbyLandmark[]>(cacheType, lat, lon);
	if (cached !== undefined) return cached;

	const query = `
		[out:json][timeout:10];
		(
			node(around:${radiusM},${lat},${lon})[name][amenity];
			node(around:${radiusM},${lat},${lon})[name][tourism];
			node(around:${radiusM},${lat},${lon})[name][leisure];
			node(around:${radiusM},${lat},${lon})[name][shop];
			way(around:${radiusM},${lat},${lon})[name][amenity];
			way(around:${radiusM},${lat},${lon})[name][tourism];
			way(around:${radiusM},${lat},${lon})[name][leisure];
			way(around:${radiusM},${lat},${lon})[name][shop];
			way(around:${radiusM},${lat},${lon})[name][place];
			way(around:${radiusM},${lat},${lon})[name][highway=pedestrian];
			relation(around:${radiusM},${lat},${lon})[name][place];
		);
		out tags center;
	`;

	const res = await fetch(OVERPASS_URL, {
		method: "POST",
		headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
		body: query,
	});

	if (!res.ok) {
		console.warn(`Overpass landmarks returned ${res.status} for ${lat},${lon}`);
		return [];
	}

	const data = (await res.json()) as { elements?: OverpassElement[] };
	const landmarks: NearbyLandmark[] = [];
	for (const el of data.elements ?? []) {
		const tags = el.tags ?? {};
		const name = tags.name;
		if (!name) continue;

		const elLat = el.lat ?? el.center?.lat;
		const elLon = el.lon ?? el.center?.lon;
		if (elLat === undefined || elLon === undefined) continue;
		const distanceM = landmarkHaversine(lat, lon, elLat, elLon);

		for (const k of ["amenity", "tourism", "leisure", "shop", "place"] as const) {
			if (tags[k]) landmarks.push({ name, type: k, subtype: tags[k], distanceM });
		}
		if (tags.highway === "pedestrian") {
			landmarks.push({ name, type: "highway", subtype: "pedestrian", distanceM });
		}
	}

	landmarks.sort((a, b) => a.distanceM - b.distanceM);
	await cacheSet(cacheType, lat, lon, landmarks);
	return landmarks;
}

/**
 * Produce a short, human-readable label for a place.
 * Examples: "Brasserie Vermeer (restaurant)", "Vondelpark", "Plein 1944 (square)"
 */
export function placeLabel(result: NominatimResult): string {
	const a = result.address;

	// Specific named venue (preferred — most useful for "your day")
	if (a.amenity) return `${a.amenity}${result.type ? ` (${result.type})` : ""}`;
	if (a.tourism) return `${a.tourism}${result.type ? ` (${result.type})` : ""}`;
	if (a.leisure) return `${a.leisure}${result.type ? ` (${result.type})` : ""}`;
	if (a.shop) return `${a.shop}${result.type ? ` (${result.type})` : ""}`;

	// Building name + type
	if (a.building && result.type) return `${a.building} (${result.type})`;

	// Named pedestrian area / square (zoom-16 lookups commonly land here)
	if (a.pedestrian) return `${a.pedestrian}${result.type ? ` (${result.type})` : ""}`;

	// Just the type with road/neighbourhood for context
	if (result.type && a.road) return `${result.type} on ${a.road}`;
	if (result.type && a.neighbourhood) return `${result.type} in ${a.neighbourhood}`;

	// Fall back to first part of display_name
	return result.displayName.split(",")[0] ?? "Unknown";
}

// --- Overpass API for moving segments ---

export interface NearbyWay {
	type: string; // "highway", "railway", "waterway", "aeroway"
	subtype: string; // "motorway", "rail", "subway", "river", etc.
	name?: string; // e.g. "A2", "Northern Line"
}

/**
 * Find ways (roads, rails, waterways) near a point.
 * Used to determine if a moving segment is likely a car, train, etc.
 */
export async function nearbyWays(lat: number, lon: number, radiusM = 50): Promise<NearbyWay[]> {
	const cached = await cacheGet<NearbyWay[]>("overpass", lat, lon);
	if (cached !== undefined) return cached;

	const query = `
		[out:json][timeout:10];
		(
			way(around:${radiusM},${lat},${lon})[highway];
			way(around:${radiusM},${lat},${lon})[railway];
			way(around:${radiusM},${lat},${lon})[waterway];
			way(around:${radiusM},${lat},${lon})[aeroway];
		);
		out tags;
	`;

	const res = await fetch(OVERPASS_URL, {
		method: "POST",
		headers: {
			"Content-Type": "text/plain",
			"User-Agent": USER_AGENT,
		},
		body: query,
	});

	if (!res.ok) {
		console.warn(`Overpass returned ${res.status} for ${lat},${lon}`);
		return []; // don't cache transient failures
	}

	const data = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
	const ways: NearbyWay[] = [];
	for (const el of data.elements ?? []) {
		const tags = el.tags ?? {};
		for (const type of ["highway", "railway", "waterway", "aeroway"]) {
			if (tags[type]) {
				ways.push({
					type,
					subtype: tags[type],
					name: tags.name || tags.ref,
				});
			}
		}
	}

	await cacheSet("overpass", lat, lon, ways);
	return ways;
}

/**
 * Refine a transport mode based on nearby ways and observed speed.
 *
 * Examples:
 * - Mode "driving" + nearby motorway → confidence boost, name "A2"
 * - Mode "driving" + nearby rail at high speed → likely train, not car
 * - Mode "stationary" + nearby aeroway → likely at airport
 */
export interface ModeRefinement {
	mode: string;
	confidence: "low" | "medium" | "high";
	reason: string;
	wayName?: string;
}

export function refineMode(originalMode: string, speedKmh: number, ways: NearbyWay[]): ModeRefinement {
	const railways = ways.filter((w) => w.type === "railway");
	const highways = ways.filter((w) => w.type === "highway");
	const aeroways = ways.filter((w) => w.type === "aeroway");
	const waterways = ways.filter((w) => w.type === "waterway");

	// Aeroway near a fast or stationary point
	if (aeroways.length > 0) {
		const aero = aeroways[0];
		if (aero.subtype === "runway" || aero.subtype === "taxiway") {
			return { mode: "plane", confidence: "high", reason: "on runway/taxiway", wayName: aero.name };
		}
		return { mode: "stationary", confidence: "high", reason: "at airport", wayName: aero.name };
	}

	// Major highways present? Roads vastly outnumber rails — when both match,
	// the user is more likely on the road. Used both as a tie-break and as
	// rebuttal evidence against a classifier "train" call below.
	const majorHighways = highways.filter((h) => ["motorway", "trunk", "primary", "secondary"].includes(h.subtype));

	// Railway → train, but only when no major highway is also present.
	// Without this guard the Betuweroute (rail running parallel to A15) would
	// hijack any motorway drive in that corridor.
	if (railways.length > 0 && speedKmh > 30 && majorHighways.length === 0) {
		const rail = railways[0];
		return {
			mode: "train",
			confidence: "high",
			reason: `on ${rail.subtype}`,
			wayName: rail.name,
		};
	}

	// Classifier said "train" but no rail anywhere in our samples — almost
	// certainly motorway cruise control (high linearity + steady ~100 km/h
	// matches the train profile). Downgrade to driving.
	if (originalMode === "train" && railways.length === 0) {
		if (majorHighways.length > 0) {
			const hw = majorHighways[0];
			return { mode: "driving", confidence: "high", reason: `on ${hw.subtype}`, wayName: hw.name };
		}
		return { mode: "driving", confidence: "medium", reason: "no rail evidence" };
	}

	// Highway match
	if (highways.length > 0) {
		const hw = highways[0];
		// Pedestrian-only highways
		if (hw.subtype === "footway" || hw.subtype === "path" || hw.subtype === "pedestrian") {
			if (speedKmh < 10) return { mode: "walking", confidence: "high", reason: `on ${hw.subtype}`, wayName: hw.name };
		}
		if (hw.subtype === "cycleway") {
			return { mode: "cycling", confidence: "high", reason: "on cycleway", wayName: hw.name };
		}
		if (hw.subtype === "motorway" || hw.subtype === "trunk" || hw.subtype === "primary") {
			if (speedKmh > 30) {
				return { mode: "driving", confidence: "high", reason: `on ${hw.subtype}`, wayName: hw.name };
			}
		}
		// Generic road
		return { mode: originalMode, confidence: "medium", reason: `near ${hw.subtype}`, wayName: hw.name };
	}

	// On a navigable waterway → boat. Excludes drains, ditches, streams (too small).
	const navigableWaterways = waterways.filter((w) => ["river", "canal", "fairway"].includes(w.subtype));
	if (navigableWaterways.length > 0 && speedKmh > 3 && speedKmh < 50) {
		const ww = navigableWaterways[0];
		return { mode: "boat", confidence: "medium", reason: `on ${ww.subtype}`, wayName: ww.name };
	}

	// No useful OSM context — keep original
	return { mode: originalMode, confidence: "low", reason: "no OSM context" };
}
