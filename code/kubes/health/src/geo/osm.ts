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

import { overpassFetch, USER_AGENT } from "./osm-overpass.js";

/**
 * Overpass endpoints, tried in order. The main server overpass-api.de is
 * volunteer-run and intermittently overloaded; kumi.systems is a known-good
 * mirror with similar rate limits. We fall through on fetch-throw or 5xx
 * so a primary outage doesn't poison our positive cache with empty results.
 */
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
	const json = JSON.stringify(value);
	await db()
		.insertInto("osm_cache")
		.values({
			query_type: queryType,
			lat_rounded: roundCoord(lat),
			lon_rounded: roundCoord(lon),
			result: json,
		})
		.onDuplicateKeyUpdate({ result: json })
		.execute();
}

// --- Negative caching + in-flight dedup ---

const NEGATIVE_CACHE_TTL_MS = 5 * 60_000; // 5 min — long enough to survive a rate-limit recovery

interface NegSentinel {
	_err: number; // HTTP status that caused the failure
	_at: number; // ms epoch
}

function isNegSentinel(v: unknown): v is NegSentinel {
	return typeof v === "object" && v !== null && "_err" in v && "_at" in v;
}

const inflight = new Map<string, Promise<unknown>>();

type FetcherResult<T> = { ok: true; value: T } | { ok: false; status: number };

/**
 * Common cache wrapper for OSM lookups. Handles three concerns at once:
 *
 *  - **Positive cache**: a previously-fetched valid response is returned
 *    immediately (including null / empty-array as valid "no result here").
 *  - **Negative cache (TTL)**: a 4xx/5xx fetcher result is recorded as a
 *    sentinel `{ _err, _at }`. Subsequent calls within `NEGATIVE_CACHE_TTL_MS`
 *    return `defaultEmpty` without re-fetching — protects against
 *    thundering-herd on Overpass / Nominatim outages.
 *  - **In-flight dedup**: if the same key is already being fetched, the
 *    second caller awaits the same promise instead of firing a duplicate
 *    request.
 */
async function withCache<T>(
	queryType: string,
	lat: number,
	lon: number,
	fetcher: () => Promise<FetcherResult<T>>,
	defaultEmpty: T,
): Promise<T> {
	const cached = await cacheGet<T | NegSentinel>(queryType, lat, lon);
	if (cached !== undefined) {
		if (isNegSentinel(cached)) {
			if (Date.now() - cached._at < NEGATIVE_CACHE_TTL_MS) return defaultEmpty;
			// expired — fall through to refetch
		} else {
			return cached as T;
		}
	}

	const inflightKey = `${queryType}|${roundCoord(lat)}|${roundCoord(lon)}`;
	const existing = inflight.get(inflightKey);
	if (existing) return existing as Promise<T>;

	const promise = (async () => {
		try {
			let result: FetcherResult<T>;
			try {
				result = await fetcher();
			} catch (e) {
				// Network-level failure (DNS, TLS, refused connection, etc.) —
				// fetch() throws before any HTTP status. Treat as a transient
				// failure so subsequent calls within the TTL are short-circuited;
				// without this we'd thunder on every dashboard reload.
				console.warn(`OSM fetch threw for ${queryType} ${lat},${lon}: ${e}`);
				result = { ok: false, status: 0 };
			}
			if (result.ok) {
				await cacheSet(queryType, lat, lon, result.value);
				return result.value;
			}
			await cacheSet(queryType, lat, lon, { _err: result.status, _at: Date.now() } satisfies NegSentinel);
			return defaultEmpty;
		} finally {
			inflight.delete(inflightKey);
		}
	})();
	inflight.set(inflightKey, promise);
	return promise;
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
		house_number?: string;
		road?: string;
		pedestrian?: string; // square / pedestrian street name
		neighbourhood?: string;
		suburb?: string;
		// City-like fields. Nominatim picks one of these based on the place's
		// administrative classification + population, so we have to check all.
		city?: string;
		town?: string;
		village?: string;
		municipality?: string;
		// One level up from city — used to collapse administrative
		// subdivisions of large metropolitan areas. For London boroughs
		// Nominatim returns city="City of Westminster" (or other borough)
		// and state_district="Greater London"; without this the timeline
		// would split a single London day across multiple sub-borough
		// headers. See METROPOLITAN_AREAS.
		state_district?: string;
		state?: string;
		country?: string;
		postcode?: string;
	};
}

/**
 * State-district / region values that should override the more specific
 * `city` field when picking a display name. Each entry is a metro area
 * whose administrative subdivisions are not useful as timeline headers
 * (e.g. London's 33 boroughs all live inside Greater London — the user
 * thinks of them as "London"). Extend conservatively: each addition
 * collapses fine-grained data into coarser groups.
 */
const METROPOLITAN_AREAS = new Set([
	"Greater London",
	"Greater Manchester",
	// Île-de-France: Paris + suburbs. Nominatim returns this for the
	// arrondissements.
	"Île-de-France",
]);

/**
 * Cities that are administrative subdivisions of a metropolitan area and
 * should be displayed as the metro instead. London has 33 boroughs; 31 of
 * them return city="Greater London" from Nominatim directly. The two that
 * don't — Westminster and the City of London — are historic "cities" in
 * their own right and need this explicit mapping. Extend conservatively
 * as similar cases turn up (Île-de-France's arrondissements all return
 * city="Paris" so they don't need entries here).
 */
const SUBDIVISION_TO_METRO = new Map<string, string>([
	["City of Westminster", "Greater London"],
	["City of London", "Greater London"],
]);

/**
 * Pick the best "city" name from a Nominatim result. Nominatim returns one of
 * `city`, `town`, `village`, `municipality` depending on a place's admin
 * level + population, so we walk them in preference order. Returns null when
 * the result is null or none of those fields are present.
 *
 * Used to attach a `city` to stationary segments so the timeline UI can group
 * consecutive same-city segments under one heading.
 */
export function extractCity(result: NominatimResult | null): string | null {
	if (!result) return null;
	const a = result.address;
	// If the response carries a recognised metropolitan area, use that
	// instead of the city — keeps a single London day under one header
	// instead of splitting into "City of Westminster" / "Greater London".
	if (a.state_district !== undefined && METROPOLITAN_AREAS.has(a.state_district)) {
		return a.state_district;
	}
	const raw = a.city ?? a.town ?? a.village ?? a.municipality ?? null;
	if (raw !== null) {
		const collapsed = SUBDIVISION_TO_METRO.get(raw);
		if (collapsed !== undefined) return collapsed;
	}
	return raw;
}

/**
 * Return the shared city of two reverse-geocoded points, or null. Used to
 * tag moving segments only when both endpoints agree — a 5-min walk that
 * stays inside one city earns a city header in the timeline; a long drive
 * between two cities (or a walk crossing a boundary) gets no tag and reads
 * as a transit between groups.
 */
export function commonCity(a: NominatimResult | null, b: NominatimResult | null): string | null {
	const ca = extractCity(a);
	const cb = extractCity(b);
	return ca !== null && ca === cb ? ca : null;
}

interface NominatimResponse {
	display_name?: string;
	type?: string;
	category?: string;
	class?: string;
	address?: NominatimResult["address"];
}

export async function reverseGeocode(lat: number, lon: number, zoom = 18): Promise<NominatimResult | null> {
	return withCache<NominatimResult | null>(
		`nominatim_z${zoom}`,
		lat,
		lon,
		async () => {
			const url = new URL(NOMINATIM_URL);
			url.searchParams.set("lat", lat.toString());
			url.searchParams.set("lon", lon.toString());
			url.searchParams.set("format", "json");
			url.searchParams.set("zoom", zoom.toString());

			const res = await fetch(url.toString(), { headers: { "User-Agent": USER_AGENT } });
			if (!res.ok) {
				console.warn(`Nominatim returned ${res.status} for ${lat},${lon}`);
				return { ok: false, status: res.status };
			}

			const data = (await res.json()) as NominatimResponse;
			if (!data.display_name) return { ok: true, value: null };

			return {
				ok: true,
				value: {
					displayName: data.display_name,
					type: data.type ?? "",
					category: data.class ?? data.category ?? "",
					address: data.address ?? {},
				},
			};
		},
		null,
	);
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
export interface BestPlaceOptions {
	/** Prefer residential address over a nearby amenity. Use when the segment
	 *  contains overnight hours (the user is sleeping in a building, not at
	 *  the cafe next door). */
	preferResidential?: boolean;
}

export async function bestPlace(
	lat: number,
	lon: number,
	opts: BestPlaceOptions = {},
): Promise<NominatimResult | null> {
	const detailed = await reverseGeocode(lat, lon, 18);
	if (detailed && hasSpecificVenue(detailed)) return detailed;

	// Overnight stays: trust the residential address from zoom 18 over any
	// nearby amenity. The user is in the building, not at the closest cafe.
	if (opts.preferResidential && detailed && hasResidentialAddress(detailed)) {
		return detailed;
	}

	const landmarks = await nearbyLandmarks(lat, lon, 100);
	if (landmarks.length > 0) {
		// Carry over the Nominatim address (city, road, etc.) so the
		// timeline UI can group by city even when the place name comes
		// from an Overpass landmark rather than the address itself.
		const result = landmarkToResult(pickBestLandmark(landmarks));
		if (detailed) {
			result.address = { ...detailed.address, ...result.address };
		}
		return result;
	}

	// No specific venue and no nearby landmark — fall back to the address if we have one
	if (detailed && hasResidentialAddress(detailed)) return detailed;

	const area = await reverseGeocode(lat, lon, 16);
	if (area && (hasSpecificVenue(area) || isLandmark(area))) return area;
	return detailed ?? area;
}

function hasSpecificVenue(r: NominatimResult): boolean {
	const a = r.address;
	return !!(a.amenity || a.tourism || a.leisure || a.shop);
}

function hasResidentialAddress(r: NominatimResult): boolean {
	return !!(r.address.house_number && r.address.road);
}

function isLandmark(r: NominatimResult): boolean {
	// Squares, parks, plazas, named pedestrian areas — useful even without a venue
	return r.category === "place" || r.category === "leisure" || !!r.address.pedestrian;
}

// --- Overpass: nearby named landmarks ---

/**
 * tourism subtypes that are POI markers, not venues. Skipped from
 * nearbyLandmarks so a roadside artwork or viewpoint doesn't beat a real
 * café next door for the "what is the user actually at" label.
 */
const POI_MARKER_TOURISM = new Set(["artwork", "viewpoint", "picnic_site", "information"]);

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
	type?: string; // "node" | "way" | "relation"
	lat?: number;
	lon?: number;
	center?: { lat: number; lon: number };
	tags?: Record<string, string>;
}

/** Rail-class route types in OSM. Bus, ferry, bicycle, hiking, etc. are
 *  not considered "rail" for our line-disambiguation purposes. */
const RAIL_ROUTE_TYPES = new Set(["subway", "train", "light_rail", "tram", "monorail"]);

/**
 * Extract the set of named rail-line route relations from an Overpass response.
 * Used by `linesAtPoint` after fetching route relations near a coordinate.
 * Kept as a pure function so the parsing logic is testable without mocking
 * fetch.
 *
 * Permissive input typing (`tags?: Record<string, string | undefined>`)
 * because real Overpass JSON has tags as a sparsely-populated map and
 * pickier types make test fixtures awkward without buying us safety the
 * runtime checks below don't already provide.
 */
export function extractLineNames(data: {
	elements?: ReadonlyArray<{ type?: string; tags?: Record<string, string | undefined> }>;
}): Set<string> {
	const lines = new Set<string>();
	for (const el of data.elements ?? []) {
		if (el.type !== "relation") continue;
		const tags = el.tags ?? {};
		if (tags.type !== "route") continue;
		if (!tags.route || !RAIL_ROUTE_TYPES.has(tags.route)) continue;
		const name = tags.name;
		if (!name) continue;
		lines.add(name);
	}
	return lines;
}

/**
 * Find named landmarks (squares, parks, restaurants, museums, etc.) near a
 * point. Used to label stationary stays when the centroid lands on a generic
 * residential building adjacent to the actual landmark.
 */
export async function nearbyLandmarks(lat: number, lon: number, radiusM = 100): Promise<NearbyLandmark[]> {
	const result = await withCache<NearbyLandmark[]>(
		`landmarks_r${radiusM}`,
		lat,
		lon,
		async () => {
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
			const res = await overpassFetch(query);
			if (!res.ok) {
				console.warn(`Overpass landmarks returned ${res.status} for ${lat},${lon}`);
				return { ok: false, status: res.status };
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
			return { ok: true, value: landmarks };
		},
		[],
	);
	return filterLandmarks(result);
}

/**
 * Drop POI markers that aren't venues someone "is at" for hours. A 19m-away
 * artwork on the same square as a residential building shouldn't beat a real
 * café next door for the timeline label.
 */
export function filterLandmarks(landmarks: NearbyLandmark[]): NearbyLandmark[] {
	return landmarks.filter((l) => !(l.type === "tourism" && POI_MARKER_TOURISM.has(l.subtype)));
}

export interface NearbyStation {
	name: string;
	/** "subway", "rail", "light_rail", "tram" — what Fitbit's API calls it. */
	subtype: string;
	distanceM: number;
}

/**
 * Find named rail / metro / tram stations near a point. Used to (a) annotate
 * the start and end of a tube ride with station names, and (b) infer that a
 * GPS-gap segment between two stations was a tube ride even when speed alone
 * is ambiguous. A subway_entrance is treated as evidence of the parent
 * station — we collapse adjacent entrances by name, picking the closest.
 */
/**
 * Pick the most station-like entry from a `nearbyStations` result list.
 *
 * The complication: OSM tags station entrances as separate nodes (often
 * labelled "A", "B", "C", etc. — one per physical entrance gate). For
 * a station node within walking distance of the user's GPS fix, the
 * entrance labels may be CLOSER than the station node itself. The picker
 * therefore deprioritises:
 *   1. entries with subtype = "subway_entrance"
 *   2. single-letter names (proxy for entrance labels when subtype info
 *      is missing or coincidentally "subway")
 *
 * Falls through to closest-by-distance for the remaining candidates, or
 * to entrance-letters as a last resort if nothing else is present.
 */
export function pickBestStation(stations: NearbyStation[]): NearbyStation | null {
	if (stations.length === 0) return null;
	const isEntranceLike = (s: NearbyStation): boolean => s.subtype === "subway_entrance" || /^[A-Z]\d?$/.test(s.name);
	const real = stations.filter((s) => !isEntranceLike(s));
	if (real.length > 0) {
		return [...real].sort((a, b) => a.distanceM - b.distanceM)[0];
	}
	return [...stations].sort((a, b) => a.distanceM - b.distanceM)[0];
}

export async function nearbyStations(lat: number, lon: number, radiusM = 200): Promise<NearbyStation[]> {
	return withCache<NearbyStation[]>(
		`stations_r${radiusM}`,
		lat,
		lon,
		async () => {
			const query = `
				[out:json][timeout:10];
				(
					node(around:${radiusM},${lat},${lon})[name][railway=station];
					node(around:${radiusM},${lat},${lon})[name][railway=halt];
					node(around:${radiusM},${lat},${lon})[name][railway=subway_entrance];
					node(around:${radiusM},${lat},${lon})[name][public_transport=station];
					way(around:${radiusM},${lat},${lon})[name][railway=station];
					way(around:${radiusM},${lat},${lon})[name][public_transport=station];
					relation(around:${radiusM},${lat},${lon})[name][public_transport=station];
				);
				out tags center;
			`;
			const res = await overpassFetch(query);
			if (!res.ok) {
				console.warn(`Overpass stations returned ${res.status} for ${lat},${lon}`);
				return { ok: false, status: res.status };
			}
			const data = (await res.json()) as { elements?: OverpassElement[] };
			const stations = new Map<string, NearbyStation>();
			for (const el of data.elements ?? []) {
				const tags = el.tags ?? {};
				const name = tags.name;
				if (!name) continue;
				const elLat = el.lat ?? el.center?.lat;
				const elLon = el.lon ?? el.center?.lon;
				if (elLat === undefined || elLon === undefined) continue;
				const distanceM = landmarkHaversine(lat, lon, elLat, elLon);
				// Determine subtype: subway / rail / light_rail / tram / generic.
				// Entrances get their own subtype ("subway_entrance") so the
				// picker can deprioritise them — entrance nodes are labelled
				// "A", "B", "C" in OSM and would otherwise beat the real
				// station node by distance for nearby fixes.
				let subtype = "rail";
				if (tags.railway === "subway_entrance") subtype = "subway_entrance";
				else if (tags.station === "subway") subtype = "subway";
				else if (tags.station === "light_rail") subtype = "light_rail";
				else if (tags.tram === "yes" || tags.railway === "tram_stop") subtype = "tram";
				else if (tags.railway === "halt") subtype = "halt";
				// Collapse multiple entries with same name (entrances of one station)
				// by keeping the closest.
				const existing = stations.get(name);
				if (!existing || distanceM < existing.distanceM) {
					stations.set(name, { name, subtype, distanceM });
				}
			}
			return { ok: true, value: [...stations.values()].sort((a, b) => a.distanceM - b.distanceM) };
		},
		[],
	);
}

/**
 * Find rail-class route relations whose member stops include a station near
 * the given coordinate. Used to disambiguate parallel-track line confusion:
 * given a tube ride with Wembley Park at one end and Kings Cross at the
 * other, the intersection of `linesAtPoint(wembley)` and `linesAtPoint(kc)`
 * is `{Metropolitan Line}` — Jubilee serves Wembley but not Kings Cross, so
 * it falls out of the intersection.
 *
 * Overpass query: stops/stations near the point → their containing route
 * relations → relation tags. Cached via the standard OSM cache.
 */
export async function linesAtPoint(lat: number, lon: number, radiusM = 100): Promise<Set<string>> {
	// Cache stores arrays — Set doesn't round-trip through JSON. Convert at
	// the function boundary.
	const arr = await withCache<string[]>(
		`lines_r${radiusM}`,
		lat,
		lon,
		async () => {
			const query = `
				[out:json][timeout:10];
				(
					node(around:${radiusM},${lat},${lon})[railway~"^(station|halt|stop|tram_stop)$"];
					node(around:${radiusM},${lat},${lon})[public_transport~"^(station|stop_position|platform)$"];
				);
				rel(bn)[type=route];
				out tags;
			`;
			const res = await overpassFetch(query);
			if (!res.ok) {
				console.warn(`Overpass lines returned ${res.status} for ${lat},${lon}`);
				return { ok: false, status: res.status };
			}
			const data = (await res.json()) as { elements?: OverpassElement[] };
			return { ok: true, value: [...extractLineNames(data)] };
		},
		[],
	);
	return new Set(arr);
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

	// Residential address (or any address with a clear house number).
	// Use Dutch ordering ("Plein 1944 161") since street + number reads
	// most naturally for European postal addresses.
	if (a.house_number && a.road) return `${a.road} ${a.house_number}`;

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
	return withCache<NearbyWay[]>(
		`overpass_r${radiusM}`,
		lat,
		lon,
		async () => {
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
			const res = await overpassFetch(query);
			if (!res.ok) {
				console.warn(`Overpass returned ${res.status} for ${lat},${lon}`);
				return { ok: false, status: res.status };
			}

			const data = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
			const ways: NearbyWay[] = [];
			for (const el of data.elements ?? []) {
				const tags = el.tags ?? {};
				for (const type of ["highway", "railway", "waterway", "aeroway"]) {
					if (tags[type]) {
						ways.push({ type, subtype: tags[type], name: tags.name || tags.ref });
					}
				}
			}
			return { ok: true, value: ways };
		},
		[],
	);
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
