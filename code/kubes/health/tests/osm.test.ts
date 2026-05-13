import { describe, expect, it } from "vitest";
import {
	commonCity,
	extractCity,
	extractLineNames,
	filterLandmarks,
	landmarkToResult,
	type NearbyLandmark,
	type NearbyStation,
	type NearbyWay,
	type NominatimResult,
	pickBestLandmark,
	pickBestStation,
	placeLabel,
	refineMode,
} from "../src/geo/osm.js";

describe("commonCity", () => {
	const r = (city?: string, town?: string): NominatimResult => ({
		displayName: "x",
		type: "y",
		category: "z",
		address: { ...(city && { city }), ...(town && { town }) },
	});

	it("returns the shared city when both endpoints agree", () => {
		expect(commonCity(r("Tilburg"), r("Tilburg"))).toBe("Tilburg");
	});

	it("returns null when the endpoints disagree", () => {
		expect(commonCity(r("Nijmegen"), r("Brussels"))).toBeNull();
	});

	it("returns null when either side has no city", () => {
		expect(commonCity(r(), r("Amsterdam"))).toBeNull();
		expect(commonCity(r("Amsterdam"), r())).toBeNull();
	});

	it("returns null when either side is null (geocode failed)", () => {
		expect(commonCity(null, r("Amsterdam"))).toBeNull();
		expect(commonCity(r("Amsterdam"), null)).toBeNull();
		expect(commonCity(null, null)).toBeNull();
	});

	it("uses the same fallback chain as extractCity (town counts)", () => {
		// One endpoint reports as `town`, the other as `city`: same place name → match.
		expect(commonCity(r(undefined, "Hilversum"), r("Hilversum"))).toBe("Hilversum");
	});
});

describe("extractCity", () => {
	const baseResult = {
		displayName: "x",
		type: "y",
		category: "z",
	};

	it("returns the city field when present", () => {
		const r: NominatimResult = { ...baseResult, address: { city: "Amsterdam" } };
		expect(extractCity(r)).toBe("Amsterdam");
	});

	it("falls back to town when no city is set", () => {
		const r: NominatimResult = { ...baseResult, address: { town: "Hilversum" } };
		expect(extractCity(r)).toBe("Hilversum");
	});

	it("falls back to village when no city or town is set", () => {
		const r: NominatimResult = { ...baseResult, address: { village: "Beek" } };
		expect(extractCity(r)).toBe("Beek");
	});

	it("falls back to municipality when no city/town/village", () => {
		const r: NominatimResult = { ...baseResult, address: { municipality: "Rotterdam-Rijnmond" } };
		expect(extractCity(r)).toBe("Rotterdam-Rijnmond");
	});

	it("prefers city over town when both are set", () => {
		const r: NominatimResult = { ...baseResult, address: { city: "Amsterdam", town: "Diemen" } };
		expect(extractCity(r)).toBe("Amsterdam");
	});

	it("returns null for an empty address", () => {
		const r: NominatimResult = { ...baseResult, address: {} };
		expect(extractCity(r)).toBeNull();
	});

	it("returns null for a null result", () => {
		expect(extractCity(null)).toBeNull();
	});

	// Coarse grouping for metropolitan areas. Nominatim returns admin
	// boundaries at multiple levels; for cities that are administratively
	// subdivided (London boroughs, Paris arrondissements) the per-fix
	// `city` field is the subdivision, not the metro area. That made the
	// timeline UI break a single London day into "Greater London → City of
	// Westminster → Greater London" headers.
	it("prefers state_district when it's a recognised metropolitan area", () => {
		const r: NominatimResult = {
			...baseResult,
			address: { city: "City of Westminster", state_district: "Greater London" },
		};
		expect(extractCity(r)).toBe("Greater London");
	});

	it("uses state_district even when city is City of London", () => {
		const r: NominatimResult = {
			...baseResult,
			address: { city: "City of London", state_district: "Greater London" },
		};
		expect(extractCity(r)).toBe("Greater London");
	});

	it("falls back to city when state_district is not a recognised metro", () => {
		// Most cities don't have a metro-area state_district. Hilversum
		// is in "Noord-Holland" — a province, not a metropolitan area —
		// so we should NOT promote it.
		const r: NominatimResult = {
			...baseResult,
			address: { city: "Hilversum", state_district: "Noord-Holland" },
		};
		expect(extractCity(r)).toBe("Hilversum");
	});

	it("falls back to city when state_district is absent", () => {
		// Most older / non-UK responses won't carry state_district.
		// Backward compat: behaves like before.
		const r: NominatimResult = { ...baseResult, address: { city: "Amsterdam" } };
		expect(extractCity(r)).toBe("Amsterdam");
	});

	it("collapses 'City of Westminster' to 'Greater London'", () => {
		// Westminster is administratively its own city in Nominatim's
		// model, so it appears as city='City of Westminster' with no
		// state_district or borough to override. Most London boroughs
		// return city='Greater London' directly; only the two 'City of'
		// subdivisions need explicit mapping.
		const r: NominatimResult = { ...baseResult, address: { city: "City of Westminster" } };
		expect(extractCity(r)).toBe("Greater London");
	});

	it("collapses 'City of London' to 'Greater London'", () => {
		const r: NominatimResult = { ...baseResult, address: { city: "City of London" } };
		expect(extractCity(r)).toBe("Greater London");
	});
});

describe("placeLabel", () => {
	it("uses amenity name when available", () => {
		const r: NominatimResult = {
			displayName: "Brasserie Vermeer, Amsterdam, Netherlands",
			type: "restaurant",
			category: "amenity",
			address: { amenity: "Brasserie Vermeer", city: "Amsterdam" },
		};
		expect(placeLabel(r)).toBe("Brasserie Vermeer (restaurant)");
	});

	it("uses building name + type when no amenity", () => {
		const r: NominatimResult = {
			displayName: "Some Office, Street, City",
			type: "office",
			category: "building",
			address: { building: "Some Office", road: "Street" },
		};
		expect(placeLabel(r)).toBe("Some Office (office)");
	});

	it("uses type + road when no amenity or building name", () => {
		const r: NominatimResult = {
			displayName: "Park, Some Road, City",
			type: "park",
			category: "leisure",
			address: { road: "Some Road" },
		};
		expect(placeLabel(r)).toBe("park on Some Road");
	});

	it("falls back to first part of display name", () => {
		const r: NominatimResult = {
			displayName: "Unknown Place, Somewhere",
			type: "",
			category: "",
			address: {},
		};
		expect(placeLabel(r)).toBe("Unknown Place");
	});

	it("uses tourism name when present (hotel, museum)", () => {
		const r: NominatimResult = {
			displayName: "Hotel Mercure, Plein 1944, Nijmegen",
			type: "hotel",
			category: "tourism",
			address: { tourism: "Hotel Mercure", road: "Plein 1944" },
		};
		expect(placeLabel(r)).toBe("Hotel Mercure (hotel)");
	});

	it("uses leisure name when present (park, playground)", () => {
		const r: NominatimResult = {
			displayName: "Vondelpark, Amsterdam",
			type: "park",
			category: "leisure",
			address: { leisure: "Vondelpark" },
		};
		expect(placeLabel(r)).toBe("Vondelpark (park)");
	});

	it("uses shop name when present", () => {
		const r: NominatimResult = {
			displayName: "Albert Heijn, Damstraat",
			type: "supermarket",
			category: "shop",
			address: { shop: "Albert Heijn", road: "Damstraat" },
		};
		expect(placeLabel(r)).toBe("Albert Heijn (supermarket)");
	});

	it("uses house_number + road for a residential address", () => {
		const r: NominatimResult = {
			displayName: "161, Plein 1944, Stadscentrum, Nijmegen, NL",
			type: "house",
			category: "place",
			address: { house_number: "161", road: "Plein 1944", suburb: "Stadscentrum" },
		};
		expect(placeLabel(r)).toBe("Plein 1944 161");
	});

	it("uses pedestrian (square / pedestrian street) name", () => {
		// Zoom-16 lookups commonly land on named squares like Plein 1944
		const r: NominatimResult = {
			displayName: "Plein 1944, Stadscentrum, Nijmegen",
			type: "square",
			category: "place",
			address: { pedestrian: "Plein 1944", neighbourhood: "Stadscentrum" },
		};
		expect(placeLabel(r)).toBe("Plein 1944 (square)");
	});
});

describe("pickBestLandmark", () => {
	it("prefers amenity over place at the same distance", () => {
		const landmarks: NearbyLandmark[] = [
			{ name: "Plein 1944", type: "place", subtype: "square", distanceM: 50 },
			{ name: "Brasserie Vermeer", type: "amenity", subtype: "restaurant", distanceM: 50 },
		];
		const best = pickBestLandmark(landmarks);
		expect(best.name).toBe("Brasserie Vermeer");
	});

	it("falls back to closest among same priority", () => {
		const landmarks: NearbyLandmark[] = [
			{ name: "Far Cafe", type: "amenity", subtype: "cafe", distanceM: 90 },
			{ name: "Near Restaurant", type: "amenity", subtype: "restaurant", distanceM: 20 },
		];
		const best = pickBestLandmark(landmarks);
		expect(best.name).toBe("Near Restaurant");
	});

	it("picks the named pedestrian square when nothing else available", () => {
		const landmarks: NearbyLandmark[] = [{ name: "Plein 1944", type: "highway", subtype: "pedestrian", distanceM: 80 }];
		const best = pickBestLandmark(landmarks);
		expect(best.name).toBe("Plein 1944");
	});
});

describe("filterLandmarks", () => {
	it("drops tourism=artwork (POI marker, not a venue)", () => {
		const ls: NearbyLandmark[] = [
			{ name: "Bairro Alto", type: "amenity", subtype: "cafe", distanceM: 30 },
			{ name: "Valkhof in Vuur en Vlam", type: "tourism", subtype: "artwork", distanceM: 19 },
		];
		const out = filterLandmarks(ls);
		expect(out.map((l) => l.name)).toEqual(["Bairro Alto"]);
	});

	it("drops other POI markers (viewpoint, picnic_site, information)", () => {
		const ls: NearbyLandmark[] = [
			{ name: "View", type: "tourism", subtype: "viewpoint", distanceM: 5 },
			{ name: "Picnic", type: "tourism", subtype: "picnic_site", distanceM: 7 },
			{ name: "Info Board", type: "tourism", subtype: "information", distanceM: 9 },
			{ name: "Hotel Mercure", type: "tourism", subtype: "hotel", distanceM: 50 },
			{ name: "Museum", type: "tourism", subtype: "museum", distanceM: 60 },
		];
		const out = filterLandmarks(ls);
		expect(out.map((l) => l.name)).toEqual(["Hotel Mercure", "Museum"]);
	});

	it("keeps non-tourism types untouched", () => {
		const ls: NearbyLandmark[] = [
			{ name: "Cafe X", type: "amenity", subtype: "cafe", distanceM: 10 },
			{ name: "Park Y", type: "leisure", subtype: "park", distanceM: 20 },
			{ name: "Shop Z", type: "shop", subtype: "supermarket", distanceM: 30 },
			{ name: "Square", type: "place", subtype: "square", distanceM: 40 },
		];
		const out = filterLandmarks(ls);
		expect(out.length).toBe(4);
	});
});

describe("landmarkToResult", () => {
	it("maps amenity into NominatimResult.address.amenity", () => {
		const r = landmarkToResult({ name: "Cafe X", type: "amenity", subtype: "cafe", distanceM: 10 });
		expect(r.address.amenity).toBe("Cafe X");
		expect(placeLabel(r)).toBe("Cafe X (cafe)");
	});

	it("maps named pedestrian area into address.pedestrian", () => {
		const r = landmarkToResult({ name: "Plein 1944", type: "highway", subtype: "pedestrian", distanceM: 50 });
		expect(r.address.pedestrian).toBe("Plein 1944");
		expect(placeLabel(r)).toBe("Plein 1944 (pedestrian)");
	});

	it("maps place=square into pedestrian (treated like a named open area)", () => {
		const r = landmarkToResult({ name: "Dam", type: "place", subtype: "square", distanceM: 30 });
		expect(r.address.pedestrian).toBe("Dam");
		expect(placeLabel(r)).toBe("Dam (square)");
	});
});

describe("refineMode", () => {
	it("upgrades driving to train when on rail at speed", () => {
		const ways: NearbyWay[] = [{ type: "railway", subtype: "rail", name: "Intercity" }];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("train");
		expect(r.confidence).toBe("high");
	});

	it("does not upgrade to train at low speed (might be near station, not on track)", () => {
		const ways: NearbyWay[] = [{ type: "railway", subtype: "rail" }];
		const r = refineMode("walking", 5, ways);
		expect(r.mode).not.toBe("train");
	});

	it("identifies cycling on cycleway", () => {
		const ways: NearbyWay[] = [{ type: "highway", subtype: "cycleway" }];
		const r = refineMode("walking", 18, ways);
		expect(r.mode).toBe("cycling");
		expect(r.confidence).toBe("high");
	});

	it("confirms walking on footway", () => {
		const ways: NearbyWay[] = [{ type: "highway", subtype: "footway" }];
		const r = refineMode("walking", 4, ways);
		expect(r.mode).toBe("walking");
		expect(r.confidence).toBe("high");
	});

	it("identifies driving on motorway", () => {
		const ways: NearbyWay[] = [{ type: "highway", subtype: "motorway", name: "A2" }];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.confidence).toBe("high");
		expect(r.wayName).toBe("A2");
	});

	it("identifies plane on runway", () => {
		const ways: NearbyWay[] = [{ type: "aeroway", subtype: "runway" }];
		const r = refineMode("driving", 250, ways);
		expect(r.mode).toBe("plane");
		expect(r.confidence).toBe("high");
	});

	it("identifies stationary at airport", () => {
		const ways: NearbyWay[] = [{ type: "aeroway", subtype: "terminal" }];
		const r = refineMode("stationary", 0, ways);
		expect(r.mode).toBe("stationary");
		expect(r.reason).toContain("airport");
	});

	it("identifies boat on waterway", () => {
		const ways: NearbyWay[] = [{ type: "waterway", subtype: "river" }];
		const r = refineMode("driving", 20, ways);
		expect(r.mode).toBe("boat");
	});

	it("does NOT classify high-speed travel as boat (boats don't go 100 km/h)", () => {
		// Driving across a bridge — Overpass might return a waterway for the centroid
		const ways: NearbyWay[] = [{ type: "waterway", subtype: "river" }];
		const r = refineMode("driving", 101, ways);
		expect(r.mode).not.toBe("boat");
	});

	it("keeps original mode when no useful OSM context", () => {
		const r = refineMode("walking", 5, []);
		expect(r.mode).toBe("walking");
		expect(r.confidence).toBe("low");
	});

	it("railway at low speed near station does not falsely flag train", () => {
		// User walking through a station - railway nearby but slow speed
		const ways: NearbyWay[] = [{ type: "railway", subtype: "rail" }];
		const r = refineMode("walking", 4, ways);
		expect(r.mode).toBe("walking"); // original kept
	});

	it("prefers motorway over parallel railway (Betuweroute parallels A15)", () => {
		// Parallel rail and motorway both nearby — the user is on the road, not the train.
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "rail", name: "Betuweroute" },
			{ type: "highway", subtype: "motorway", name: "A15" },
		];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A15");
	});

	it("downgrades classifier 'train' to 'driving' when no rail anywhere", () => {
		// Cruise control on motorway looks like train (steady, linear, fast)
		// but there's no rail in the OSM samples.
		const ways: NearbyWay[] = [{ type: "highway", subtype: "motorway", name: "A2" }];
		const r = refineMode("train", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A2");
	});

	it("downgrades classifier 'train' to 'driving' even with no OSM context", () => {
		const r = refineMode("train", 100, []);
		expect(r.mode).toBe("driving");
		expect(r.reason).toContain("no rail evidence");
	});

	it("keeps 'train' when classifier said train AND rail is nearby with no major road", () => {
		// True train ride — rail is present, no parallel motorway
		const ways: NearbyWay[] = [{ type: "railway", subtype: "rail", name: "Hoofdspoor" }];
		const r = refineMode("train", 130, ways);
		expect(r.mode).toBe("train");
		expect(r.wayName).toBe("Hoofdspoor");
	});

	it("prefers a driveable road over a closer footway at driving speeds", () => {
		// Real case from 2026-05-12: GPS fix on the 13:29-13:46 drive
		// landed on the pavement next to Great Central Way. The mirror
		// returned the footway at 21m AND Great Central Way (secondary)
		// at 27m, both within nearbyWays' 50m radius. Aggregation by
		// distance puts the footway first, and the old refineMode
		// blindly picked highways[0] → labelled the drive "near footway"
		// even though the user is clearly on a real road (61 km/h, 17
		// minutes, 17 km of travel). At driving speed the labeller must
		// pass over pedestrian-only ways and pick the closest car-road.
		const ways: NearbyWay[] = [
			{ type: "highway", subtype: "footway" },
			{ type: "highway", subtype: "secondary", name: "Great Central Way" },
		];
		const r = refineMode("driving", 61, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("Great Central Way");
		expect(r.reason).toContain("secondary");
	});

	it("still picks the footway for walking speeds (no over-correction)", () => {
		// Same way list, walking speed — the user really IS on the
		// footway. The mode-aware filter must NOT kick in at walking
		// speeds; we want "on footway" here, not "on secondary".
		const ways: NearbyWay[] = [
			{ type: "highway", subtype: "footway" },
			{ type: "highway", subtype: "secondary", name: "Some Road" },
		];
		const r = refineMode("walking", 4, ways);
		expect(r.mode).toBe("walking");
		expect(r.reason).toContain("footway");
	});

	it("prefers train when rail is closer than parallel major road (tube under arterial)", () => {
		// Real case from 2026-05-12 13:29: Jubilee line surface trace
		// 20m from one sample, Bridge Road (primary) 30m from same
		// sample. Old guard refused train because a major highway was
		// "present" anywhere → labelled as driving on Bridge Road. New
		// distance-aware tie-break: rail closer than road → train.
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "subway", name: "Jubilee Line", distanceM: 20 },
			{ type: "highway", subtype: "primary", name: "Bridge Road", distanceM: 30 },
		];
		const r = refineMode("driving", 65, ways);
		expect(r.mode).toBe("train");
		expect(r.wayName).toBe("Jubilee Line");
	});

	it("keeps driving when major road is closer than parallel rail (Betuweroute)", () => {
		// Original Betuweroute case re-stated with distances: A15 at 10m
		// hugs the GPS trace, Betuweroute rail at 30m runs alongside.
		// Road closer → driving wins (old behaviour preserved by the
		// distance comparison, not by the presence rule).
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "rail", name: "Betuweroute", distanceM: 30 },
			{ type: "highway", subtype: "motorway", name: "A15", distanceM: 10 },
		];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A15");
	});

	it("falls back to presence-based rule when distanceM is missing (back-compat)", () => {
		// Callers that don't (yet) pass distanceM keep the original
		// behaviour: any major highway present blocks the train branch.
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "rail", name: "Betuweroute" },
			{ type: "highway", subtype: "motorway", name: "A15" },
		];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A15");
	});

	it("falls back to the footway label when no driveable road is in range", () => {
		// Driving speed but only pedestrian-only ways nearby. The fix
		// shouldn't silently swallow this — the label still reflects
		// the only highway we can see ("near footway") rather than
		// pretending there's a road. Worth keeping because it makes the
		// regression case (the 13:29 drive when truly no road is in
		// range) visible in the UI rather than hidden behind a generic
		// fallback.
		const ways: NearbyWay[] = [
			{ type: "highway", subtype: "footway" },
			{ type: "highway", subtype: "path" },
		];
		const r = refineMode("driving", 61, ways);
		expect(r.mode).toBe("driving");
		expect(r.reason).toContain("footway");
	});
});

describe("pickBestStation", () => {
	// When a rail run ends at an overground station, the first post-train
	// GPS fix is often 200-400m from the station (phone reports lag in
	// time + walking distance). Increasing the search radius brings the
	// real station into range, but also pulls in OSM's many `subway_
	// entrance` nodes labelled by letter (A, B, C, D, E). The picker must
	// prefer the actual station name over single-letter entrance labels.

	const s = (name: string, subtype: string, distanceM: number): NearbyStation => ({
		name,
		subtype,
		distanceM,
	});

	it("returns null for an empty list", () => {
		expect(pickBestStation([])).toBeNull();
	});

	it("prefers a station entry over closer entrance-letter labels", () => {
		// Real Wembley Park dump from production:
		const out = pickBestStation([
			s("A", "subway_entrance", 242),
			s("B", "subway_entrance", 258),
			s("Wembley Park", "subway", 260),
			s("C", "subway_entrance", 274),
		]);
		expect(out?.name).toBe("Wembley Park");
	});

	it("falls back to the closest station when all are equivalent type", () => {
		const out = pickBestStation([
			s("King's Cross St Pancras", "subway", 143),
			s("King's Cross St Pancras Underground Station", "subway", 173),
		]);
		expect(out?.name).toBe("King's Cross St Pancras");
	});

	it("falls back to entrance when no actual station is present", () => {
		// If a station node isn't tagged but only its entrances are, take
		// the closest entrance rather than returning nothing.
		const out = pickBestStation([s("A", "subway_entrance", 200), s("B", "subway_entrance", 220)]);
		expect(out?.name).toBe("A");
	});

	it("filters out single-letter names if a multi-letter alternative exists", () => {
		// Defensive: even if subtype info is missing/unreliable, a single-
		// letter name "A" is almost certainly an entrance label, not a
		// real station name.
		const out = pickBestStation([s("A", "subway", 240), s("Wembley Park", "subway", 260)]);
		expect(out?.name).toBe("Wembley Park");
	});
});

describe("extractLineNames", () => {
	// Overpass returns relation elements that are route members of a stop
	// node near a queried point. We only want named route relations whose
	// route= tag identifies a rail-class line.
	it("returns the set of named rail lines from an Overpass response", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "subway", name: "Metropolitan Line" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Jubilee Line" } },
				{ type: "relation", tags: { type: "route", route: "train", name: "Thameslink" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Metropolitan Line", "Jubilee Line", "Thameslink"]));
	});

	it("ignores non-route relations (e.g. boundaries, multipolygons)", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "boundary", name: "Greater London" } },
				{ type: "relation", tags: { type: "multipolygon", name: "Hyde Park" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Piccadilly Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Piccadilly Line"]));
	});

	it("ignores non-rail routes (bus, ferry, bicycle)", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "bus", name: "139" } },
				{ type: "relation", tags: { type: "route", route: "ferry", name: "Woolwich Ferry" } },
				{ type: "relation", tags: { type: "route", route: "bicycle", name: "NCN 4" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Victoria Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Victoria Line"]));
	});

	it("includes train, light_rail, tram, monorail as rail-class routes", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "train", name: "Elizabeth Line" } },
				{ type: "relation", tags: { type: "route", route: "light_rail", name: "DLR" } },
				{ type: "relation", tags: { type: "route", route: "tram", name: "Tramlink 1" } },
				{ type: "relation", tags: { type: "route", route: "monorail", name: "Disney Monorail" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Elizabeth Line", "DLR", "Tramlink 1", "Disney Monorail"]));
	});

	it("skips relations without a name tag", () => {
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "subway" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Bakerloo Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Bakerloo Line"]));
	});

	it("deduplicates lines that appear in multiple route directions", () => {
		// OSM often has one route relation per direction or per service
		// variant (e.g. Met Line Aldgate-Uxbridge, Aldgate-Amersham). They
		// share the same name; we want the line counted once.
		const data = {
			elements: [
				{ type: "relation", tags: { type: "route", route: "subway", name: "Metropolitan Line" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Metropolitan Line" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Metropolitan Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Metropolitan Line"]));
	});

	it("returns an empty set for empty or undefined elements", () => {
		expect(extractLineNames({ elements: [] })).toEqual(new Set());
		expect(extractLineNames({})).toEqual(new Set());
	});

	it("ignores non-relation elements (ways, nodes)", () => {
		const data = {
			elements: [
				{ type: "node", tags: { railway: "station", name: "Kings Cross" } },
				{ type: "way", tags: { highway: "primary", name: "Euston Road" } },
				{ type: "relation", tags: { type: "route", route: "subway", name: "Northern Line" } },
			],
		};
		expect(extractLineNames(data)).toEqual(new Set(["Northern Line"]));
	});
});
