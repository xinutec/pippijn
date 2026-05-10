import { describe, expect, it } from "vitest";
import { type NearbyWay, type NominatimResult, placeLabel, refineMode } from "../src/geo/osm.js";

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
});
