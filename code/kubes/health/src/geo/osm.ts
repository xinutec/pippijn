/**
 * OpenStreetMap enrichment for transport segments.
 *
 * - Stationary segments: reverse-geocode the centroid via Nominatim to get place name/type
 * - Moving segments: query Overpass for nearby ways (highway, railway, etc.) to refine the mode
 *
 * Both APIs are free public services with rate limits — we make a few queries per
 * day per user, which is well within limits. Self-host if usage grows.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "health.xinutec.org (pippijn@xinutec.org)";

// --- Nominatim reverse geocoding ---

export interface NominatimResult {
	displayName: string;
	type: string; // e.g. "restaurant", "cafe", "park", "residential"
	category: string; // top-level category, e.g. "amenity", "leisure", "building"
	address: {
		amenity?: string;
		building?: string;
		road?: string;
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

export async function reverseGeocode(lat: number, lon: number): Promise<NominatimResult | null> {
	const url = new URL(NOMINATIM_URL);
	url.searchParams.set("lat", lat.toString());
	url.searchParams.set("lon", lon.toString());
	url.searchParams.set("format", "json");
	url.searchParams.set("zoom", "18"); // building-level detail

	const res = await fetch(url.toString(), {
		headers: { "User-Agent": USER_AGENT },
	});

	if (!res.ok) {
		console.warn(`Nominatim returned ${res.status} for ${lat},${lon}`);
		return null;
	}

	const data = (await res.json()) as NominatimResponse;
	if (!data.display_name) return null;

	return {
		displayName: data.display_name,
		type: data.type ?? "",
		category: data.class ?? data.category ?? "",
		address: data.address ?? {},
	};
}

/**
 * Produce a short, human-readable label for a place.
 * Examples: "Brasserie Vermeer (restaurant)", "Vondelpark", "Wembley Park station"
 */
export function placeLabel(result: NominatimResult): string {
	const a = result.address;

	// Prefer named amenity (restaurant, cafe, etc.)
	if (a.amenity) return `${a.amenity}${result.type ? ` (${result.type})` : ""}`;

	// Building name + type
	if (a.building && result.type) return `${a.building} (${result.type})`;

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
		return [];
	}

	const data = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
	if (!data.elements) return [];

	const ways: NearbyWay[] = [];
	for (const el of data.elements) {
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

	// Railway with reasonable speed → train (overrides "driving" at 100 km/h)
	if (railways.length > 0 && speedKmh > 30) {
		const rail = railways[0];
		const subway = rail.subtype === "subway" || rail.subtype === "light_rail";
		return {
			mode: subway ? "train" : "train",
			confidence: "high",
			reason: `on ${rail.subtype}`,
			wayName: rail.name,
		};
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

	// On a waterway → boat
	if (waterways.length > 0 && speedKmh > 3) {
		const ww = waterways[0];
		return { mode: "boat", confidence: "medium", reason: `on ${ww.subtype}`, wayName: ww.name };
	}

	// No useful OSM context — keep original
	return { mode: originalMode, confidence: "low", reason: "no OSM context" };
}
