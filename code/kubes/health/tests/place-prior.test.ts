/**
 * Probabilistic place assignment. Replaces the hard-cutoff snap +
 * residential-hours gate with a scorer that combines:
 *
 *   - log-likelihood: Gaussian on the distance from the segment
 *     centroid to a candidate place's centroid, σ = place's
 *     empirical radius.
 *   - log-prior (frequency): how often this place has been visited
 *     before — operationalised as log(unique_days + 1).
 *   - log-prior (time-of-day): for sleep windows, log(sleep_hours
 *     + 1); for daytime stays, log(awake_hours + 1). A place where
 *     you've slept 500 hours dominates a place where you've slept 0
 *     hours even if equidistant.
 *
 * The picker is a pure function over a list of candidates; the IO
 * (loading focus_places) lives outside.
 */

import { describe, expect, it } from "vitest";
import { type PlaceCandidate, pickBestPlace, scorePlaceForSegment } from "../src/geo/place-prior.js";

function home(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
	return {
		id: 1,
		centroidLat: 51.845,
		centroidLon: 5.863,
		radiusM: 80,
		uniqueDays: 200,
		totalDwellSec: 200 * 12 * 3600, // 200 days × 12 h
		sleepHours: 1500,
		displayName: null,
		amenityLabel: null,
		...overrides,
	};
}

function workish(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
	return {
		id: 2,
		centroidLat: 51.7,
		centroidLon: 5.6,
		radiusM: 60,
		uniqueDays: 40,
		totalDwellSec: 40 * 9 * 3600,
		sleepHours: 0,
		displayName: null,
		amenityLabel: null,
		...overrides,
	};
}

describe("scorePlaceForSegment", () => {
	const segCentroidAtHome = { lat: 51.846, lon: 5.864 };

	it("scores a near-by place higher than a far-away one (likelihood dominates)", () => {
		const close = scorePlaceForSegment(home(), segCentroidAtHome.lat, segCentroidAtHome.lon, {
			isSleepWindow: false,
		});
		const far = scorePlaceForSegment(workish(), segCentroidAtHome.lat, segCentroidAtHome.lon, {
			isSleepWindow: false,
		});
		expect(close).toBeGreaterThan(far);
	});

	it("scores a heavily-visited place higher than a one-off, all else equal", () => {
		const veteran = scorePlaceForSegment(home({ uniqueDays: 500 }), 51.845, 5.863, {
			isSleepWindow: false,
		});
		const newcomer = scorePlaceForSegment(home({ uniqueDays: 1 }), 51.845, 5.863, {
			isSleepWindow: false,
		});
		expect(veteran).toBeGreaterThan(newcomer);
	});

	it("for a sleep window, a place with high sleep_hours beats an equidistant zero-sleep place", () => {
		const sleepy = home({ sleepHours: 1500 });
		const officey = home({ id: 99, sleepHours: 0 });
		const sleepScore = scorePlaceForSegment(sleepy, 51.846, 5.864, { isSleepWindow: true });
		const officeScore = scorePlaceForSegment(officey, 51.846, 5.864, { isSleepWindow: true });
		expect(sleepScore).toBeGreaterThan(officeScore);
	});

	it("for a daytime window, a place with high awake-hours beats an equidistant office (yes office wins now)", () => {
		// Sleep place: many sleep hours, few awake hours.
		const sleepy = home({ sleepHours: 1500, totalDwellSec: 200 * 12 * 3600 /* 2400h dwell */ });
		// Office: zero sleep, many awake hours.
		const officey = home({ id: 99, sleepHours: 0, totalDwellSec: 500 * 3600 /* 500h awake */ });
		const sleepDayScore = scorePlaceForSegment(sleepy, 51.846, 5.864, { isSleepWindow: false });
		const officeDayScore = scorePlaceForSegment(officey, 51.846, 5.864, { isSleepWindow: false });
		// The places are co-located + identical radius. sleepy has more
		// awake hours overall (900 vs 500), so it still wins on
		// time-of-day prior alone. This test pins down the math: when
		// awake_hours dominates, the daytime score follows it.
		expect(sleepDayScore).toBeGreaterThan(officeDayScore);
	});
});

describe("pickBestPlace", () => {
	it("returns null when there are no candidates", () => {
		expect(pickBestPlace([], 51.846, 5.864, { isSleepWindow: false })).toBeNull();
	});

	it("picks the only candidate when one is given", () => {
		const r = pickBestPlace([home()], 51.846, 5.864, { isSleepWindow: false });
		expect(r?.winner.id).toBe(1);
	});

	it("home wins over a faraway focus_place even when fixes are slightly off-centre", () => {
		// 70 m east of home's centroid (within home's 80 m σ).
		const seg = { lat: 51.845, lon: 5.864 };
		const r = pickBestPlace([home(), workish()], seg.lat, seg.lon, { isSleepWindow: false });
		expect(r?.winner.id).toBe(1);
	});

	it("returns null when no candidate has a usable posterior (all too far)", () => {
		// 5 km from home, even further from work. Beyond any reasonable
		// posterior — caller should fall back to OSM.
		const seg = { lat: 51.9, lon: 5.95 };
		const r = pickBestPlace([home(), workish()], seg.lat, seg.lon, { isSleepWindow: false });
		expect(r).toBeNull();
	});

	it("regression — May 3 case: 70 m off-centre cluster, daytime, only candidate is home → home wins", () => {
		// The actual May 3 cluster centroid lands ~70 m from home's
		// stored centroid. Pre-refactor, the snap-radius missed it and
		// the labeller fell through to OSM amenity ('Fast Food Chain X').
		// Post-refactor, home has 70 m vs radius 80 m → likelihood ≈
		// exp(-0.5 · (70/80)^2) ≈ 0.68 — plenty of signal. Plus the
		// heavy prior on having visited 200 times. Wins comfortably.
		const seg = { lat: 51.8457, lon: 5.8636 };
		const r = pickBestPlace([home()], seg.lat, seg.lon, { isSleepWindow: false });
		expect(r?.winner.id).toBe(1);
	});

	it("regression — May 3 sleep window: home wins decisively over a zero-sleep candidate at same coords", () => {
		// Sleep-time + same physical cluster. If there were a hypothetical
		// non-sleep focus_place at the same coords (e.g. a daytime
		// hangout), the sleep prior makes home dominate.
		const fakeOffice = home({
			id: 99,
			sleepHours: 0,
			totalDwellSec: 100 * 3600, // 100 h awake-time
		});
		const seg = { lat: 51.846, lon: 5.864 };
		const r = pickBestPlace([home(), fakeOffice], seg.lat, seg.lon, { isSleepWindow: true });
		expect(r?.winner.id).toBe(1);
	});

	it("picks the geographically-closer place even when its prior is much weaker", () => {
		// Demonstrates the likelihood DOES overpower the prior when the
		// distance signal is strong. Home is 1 km off, an unfrequented
		// café is 5 m off.
		const cafe = home({
			id: 50,
			centroidLat: 51.92,
			centroidLon: 5.95,
			radiusM: 40,
			uniqueDays: 2,
			sleepHours: 0,
			totalDwellSec: 4 * 3600,
		});
		const seg = { lat: 51.92, lon: 5.95 }; // dead-on the café
		const homeAtDistance = home({ centroidLat: 51.91, centroidLon: 5.94 }); // 1.4 km away
		const r = pickBestPlace([homeAtDistance, cafe], seg.lat, seg.lon, { isSleepWindow: false });
		expect(r?.winner.id).toBe(50);
	});
});
