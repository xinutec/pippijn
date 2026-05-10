import { describe, expect, it } from "vitest";
import {
	landmarkToResult,
	type NearbyLandmark,
	type NearbyWay,
	type NominatimResult,
	pickBestLandmark,
	placeLabel,
	refineMode,
} from "../src/geo/osm.js";

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
});
