import { describe, expect, it } from "vitest";
import { apiRoutes, MeasurementsQuery } from "../src/routes/api.js";

// Route-level tests for the request-validation edges: auth and payload/query
// rejection. Success paths need a live MariaDB and are exercised by the
// deployed service, not here.
const TOKEN = "test-token-0123456789";
const app = apiRoutes(TOKEN);

describe("POST /ingest auth", () => {
	it("rejects a missing token", async () => {
		const res = await app.request("/ingest", { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
	});

	it("rejects a wrong token", async () => {
		const res = await app.request("/ingest", {
			method: "POST",
			headers: { Authorization: "Bearer wrong" },
			body: "{}",
		});
		expect(res.status).toBe(401);
	});

	it("rejects an invalid payload with a valid token", async () => {
		const res = await app.request("/ingest", {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ humidity: 250 }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a non-JSON body with a valid token", async () => {
		const res = await app.request("/ingest", {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});
});

describe("POST /ingest/batch auth", () => {
	it("rejects a missing token", async () => {
		const res = await app.request("/ingest/batch", { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
	});

	it("rejects an empty batch with a valid token", async () => {
		const res = await app.request("/ingest/batch", {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ measurements: [] }),
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /measurements query validation", () => {
	it("rejects a malformed from/to instead of silently ignoring it", async () => {
		for (const qs of ["from=garbage", "to=garbage", "from="]) {
			const res = await app.request(`/measurements?${qs}`);
			expect(res.status, qs).toBe(400);
		}
	});

	it("rejects an out-of-range or non-numeric limit", async () => {
		for (const qs of ["limit=0", "limit=-5", "limit=1e9", "limit=lots", "limit=20001"]) {
			const res = await app.request(`/measurements?${qs}`);
			expect(res.status, qs).toBe(400);
		}
	});
});

describe("MeasurementsQuery", () => {
	it("applies defaults", () => {
		const q = MeasurementsQuery.parse({});
		expect(q.device).toBe("airvisual");
		expect(q.limit).toBe(5000);
		expect(q.from).toBeUndefined();
	});

	it("parses ISO instants", () => {
		const q = MeasurementsQuery.parse({ from: "2026-07-01T00:00:00.000Z", limit: "20000" });
		expect(q.from?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
		expect(q.limit).toBe(20000);
	});
});
