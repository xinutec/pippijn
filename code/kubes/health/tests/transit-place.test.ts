import { describe, expect, it } from "vitest";
import type { NearbyStation } from "../src/geo/osm.js";
import { STATION_AT_ALIGHT_RADIUS_M, stationAtTrainAlight } from "../src/geo/transit-place.js";
import { mockOsmAdapter } from "./helpers/mock-osm-adapter.js";

const station = (name: string, distanceM: number): NearbyStation => ({ name, subtype: "subway", distanceM });
const LAT = 51.547;
const LON = -0.18;

describe("stationAtTrainAlight", () => {
	it("names the station when a train-alighting stay sits within range", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Finchley Road", 40)] });
		expect(await stationAtTrainAlight({ mode: "train" }, LAT, LON, osm)).toBe("Finchley Road");
	});

	it("honours refinedMode when the base mode differs", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Finchley Road", 40)] });
		expect(await stationAtTrainAlight({ mode: "driving", refinedMode: "train" }, LAT, LON, osm)).toBe("Finchley Road");
	});

	it("returns the nearest of several stations", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Far", 120), station("Near", 30)] });
		expect(await stationAtTrainAlight({ mode: "train" }, LAT, LON, osm)).toBe("Near");
	});

	it("does not fire when the preceding segment is not a train", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Finchley Road", 40)] });
		expect(await stationAtTrainAlight({ mode: "walking" }, LAT, LON, osm)).toBeNull();
	});

	it("does not fire with no preceding segment (first stay of the day)", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Finchley Road", 40)] });
		expect(await stationAtTrainAlight(undefined, LAT, LON, osm)).toBeNull();
	});

	it("returns null when the nearest station is beyond the footprint", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [station("Finchley Road", 400)] });
		expect(await stationAtTrainAlight({ mode: "train" }, LAT, LON, osm, STATION_AT_ALIGHT_RADIUS_M)).toBeNull();
	});

	it("returns null when no station is nearby (train ended mid-network gap)", async () => {
		const osm = mockOsmAdapter({ nearbyStations: () => [] });
		expect(await stationAtTrainAlight({ mode: "train" }, LAT, LON, osm)).toBeNull();
	});
});
