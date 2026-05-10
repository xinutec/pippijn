/**
 * Cache-correctness tests for src/geo/osm.ts.
 *
 * Mocks the DB pool + global.fetch so we can drive cacheGet/cacheSet through
 * the public functions (nearbyWays, nearbyLandmarks, reverseGeocode) and
 * assert behaviour around: key composition, in-flight dedup, and negative
 * caching for transient failures (429).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- DB pool mock — minimal Kysely-shaped chain that records calls ---

interface CacheRow {
	query_type: string;
	lat_rounded: number;
	lon_rounded: number;
	result: string;
}

const cacheStore: CacheRow[] = [];
const cacheGetCalls: Array<{ query_type: string; lat_rounded: number; lon_rounded: number }> = [];
const cacheSetCalls: Array<{ query_type: string; lat_rounded: number; lon_rounded: number; result: string }> = [];

function findRow(qt: string, lat: number, lon: number): CacheRow | null {
	return cacheStore.find((r) => r.query_type === qt && r.lat_rounded === lat && r.lon_rounded === lon) ?? null;
}

function makeSelectChain() {
	const filters: Record<string, unknown> = {};
	const builder = {
		select: () => builder,
		where(col: string, _op: string, val: unknown) {
			filters[col] = val;
			return builder;
		},
		executeTakeFirst: async () => {
			cacheGetCalls.push({
				query_type: filters.query_type as string,
				lat_rounded: filters.lat_rounded as number,
				lon_rounded: filters.lon_rounded as number,
			});
			const row = findRow(filters.query_type as string, filters.lat_rounded as number, filters.lon_rounded as number);
			return row ? { result: row.result } : undefined;
		},
	};
	return builder;
}

function makeInsertChain() {
	let pendingValues: CacheRow | null = null;
	let dupUpdate: { result: string } | null = null;
	const builder = {
		values(v: { query_type: string; lat_rounded: number; lon_rounded: number; result: string }) {
			pendingValues = v as CacheRow;
			return builder;
		},
		onDuplicateKeyUpdate(u: { result: string }) {
			dupUpdate = u;
			return builder;
		},
		execute: async () => {
			if (!pendingValues) return;
			cacheSetCalls.push({ ...pendingValues });
			const existing = findRow(pendingValues.query_type, pendingValues.lat_rounded, pendingValues.lon_rounded);
			if (existing) {
				existing.result = dupUpdate?.result ?? pendingValues.result;
			} else {
				cacheStore.push({ ...pendingValues });
			}
		},
	};
	return builder;
}

vi.mock("../src/db/pool.js", () => {
	const mockDb = {
		selectFrom: (_table: string) => makeSelectChain(),
		insertInto: (_table: string) => makeInsertChain(),
	};
	return { db: () => mockDb };
});

// --- fetch mock ---

let fetchHandler: (input: unknown, init?: unknown) => Promise<Response> = async () => {
	throw new Error("fetch handler not set");
};
const fetchCalls: Array<{ url: string; init: unknown }> = [];

beforeEach(() => {
	cacheStore.length = 0;
	cacheGetCalls.length = 0;
	cacheSetCalls.length = 0;
	fetchCalls.length = 0;
	fetchHandler = async () => {
		throw new Error("fetch handler not set");
	};
	globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
		const url = typeof input === "string" ? input : (input as URL).toString();
		fetchCalls.push({ url, init });
		return fetchHandler(input, init);
	}) as unknown as typeof fetch;
	// Reset module-level inflight map between tests by re-importing
	vi.resetModules();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// Helper to dynamically import the module fresh per test (clears inflight map)
async function loadOsm() {
	return await import("../src/geo/osm.js");
}

// --- Tests ---

describe("cache key composition", () => {
	it("nearbyWays cache key includes radiusM (different radii → different keys)", async () => {
		const { nearbyWays } = await loadOsm();
		fetchHandler = async () =>
			new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "Content-Type": "application/json" } });

		await nearbyWays(51.0, 5.0, 50);
		await nearbyWays(51.0, 5.0, 100);

		// Both calls should miss cache and hit fetch (different keys)
		expect(fetchCalls).toHaveLength(2);
		// Cache writes should land at different query_types
		const writeTypes = cacheSetCalls.map((c) => c.query_type);
		expect(new Set(writeTypes).size).toBe(2);
	});
});

describe("in-flight request dedup", () => {
	it("two simultaneous calls for the same key fire fetch only once", async () => {
		const { nearbyWays } = await loadOsm();
		// Make fetch take some time so the two calls overlap
		let resolveFetch: (v: Response) => void = () => {};
		const fetchPromise = new Promise<Response>((r) => {
			resolveFetch = r;
		});
		fetchHandler = () => fetchPromise;

		const p1 = nearbyWays(51.0, 5.0);
		const p2 = nearbyWays(51.0, 5.0);

		// Resolve fetch with empty response
		resolveFetch(
			new Response(JSON.stringify({ elements: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		await Promise.all([p1, p2]);

		expect(fetchCalls).toHaveLength(1); // only one fetch despite two callers
	});

	it("simultaneous calls for different keys both fetch", async () => {
		const { nearbyWays } = await loadOsm();
		fetchHandler = async () =>
			new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "Content-Type": "application/json" } });

		await Promise.all([nearbyWays(51.0, 5.0), nearbyWays(52.0, 5.0)]);

		expect(fetchCalls).toHaveLength(2);
	});
});

describe("negative caching for transient failures (429)", () => {
	it("nearbyWays caches a 429 response so a follow-up call doesn't re-fetch", async () => {
		const { nearbyWays } = await loadOsm();
		fetchHandler = async () => new Response("Too Many Requests", { status: 429 });

		const r1 = await nearbyWays(51.0, 5.0);
		expect(r1).toEqual([]);
		const r2 = await nearbyWays(51.0, 5.0);
		expect(r2).toEqual([]);

		// First call tries both Overpass mirrors before negative-caching;
		// second call hits negative cache and doesn't fetch.
		expect(fetchCalls).toHaveLength(2);
	});

	it("reverseGeocode caches a 429 response so a follow-up call doesn't re-fetch", async () => {
		// Nominatim has no mirror fallback (single endpoint), so 1 fetch only.
		const { reverseGeocode } = await loadOsm();
		fetchHandler = async () => new Response("Too Many Requests", { status: 429 });

		const r1 = await reverseGeocode(51.0, 5.0);
		expect(r1).toBeNull();
		const r2 = await reverseGeocode(51.0, 5.0);
		expect(r2).toBeNull();

		expect(fetchCalls).toHaveLength(1);
	});

	it("nearbyLandmarks caches a 429 response", async () => {
		const { nearbyLandmarks } = await loadOsm();
		fetchHandler = async () => new Response("Too Many Requests", { status: 429 });

		await nearbyLandmarks(51.0, 5.0);
		await nearbyLandmarks(51.0, 5.0);

		// Two mirrors tried, then cached.
		expect(fetchCalls).toHaveLength(2);
	});

	it("a 5xx response is also negatively cached (transient server error)", async () => {
		const { nearbyWays } = await loadOsm();
		fetchHandler = async () => new Response("Bad Gateway", { status: 502 });

		await nearbyWays(51.0, 5.0);
		await nearbyWays(51.0, 5.0);

		expect(fetchCalls).toHaveLength(2);
	});

	it("Overpass mirror fallback: primary fails, secondary succeeds → cached as success", async () => {
		const { nearbyWays } = await loadOsm();
		// Track which Overpass URL was hit
		fetchHandler = async (input) => {
			const url = typeof input === "string" ? input : (input as URL).toString();
			if (url.includes("overpass-api.de")) {
				throw new Error("primary down");
			}
			return new Response(JSON.stringify({ elements: [{ tags: { highway: "motorway", name: "A2" } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const r = await nearbyWays(51.0, 5.0);
		expect(r).toHaveLength(1);
		expect(r[0].name).toBe("A2");

		// A second call with the same coords should hit cache, not re-fetch
		const r2 = await nearbyWays(51.0, 5.0);
		expect(r2).toEqual(r);
		// 2 fetch calls: 1× primary (failed) + 1× secondary (succeeded). No retries.
		const overpassFetches = fetchCalls.filter((c) => c.url.includes("overpass"));
		expect(overpassFetches).toHaveLength(2);
	});

	it("Overpass mirror fallback: both fail → negative cache, no thundering", async () => {
		const { nearbyWays } = await loadOsm();
		fetchHandler = async () => {
			throw new Error("network down");
		};

		const r1 = await nearbyWays(51.0, 5.0);
		const r2 = await nearbyWays(51.0, 5.0);
		expect(r1).toEqual([]);
		expect(r2).toEqual([]);
		// First call: 2 fetches (primary + secondary). Second call: 0 (neg cache).
		expect(fetchCalls).toHaveLength(2);
	});

	it("Overpass mirror fallback: primary succeeds → secondary never tried", async () => {
		const { nearbyWays } = await loadOsm();
		fetchHandler = async () => {
			return new Response(JSON.stringify({ elements: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await nearbyWays(51.0, 5.0);
		// Just one fetch — no fallback needed
		expect(fetchCalls).toHaveLength(1);
	});

	it("a thrown fetch (network/TLS/refused connection) is also negatively cached", async () => {
		// Simulates the production case where Overpass becomes unreachable —
		// fetch() throws before any HTTP status. Both mirrors tried, then cached.
		const { nearbyWays } = await loadOsm();
		fetchHandler = async () => {
			throw new Error("fetch failed");
		};

		const r1 = await nearbyWays(51.0, 5.0);
		const r2 = await nearbyWays(51.0, 5.0);
		expect(r1).toEqual([]);
		expect(r2).toEqual([]);
		expect(fetchCalls).toHaveLength(2);
	});
});
