/**
 * HTTP-route-level tests for the Owntracks proxy.
 *
 * The pure-function tests in `owntracks.test.ts` cover the decision
 * pipeline. This file covers the gates *before* we touch any state or
 * upstream: token allowlist, Authorization presence, body-size limit.
 *
 * fetch() is stubbed so the tests don't make real outbound calls to
 * Nextcloud — only what the proxy decides about each request is
 * inspected here.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { owntracksRoutes } from "../src/routes/owntracks.js";

const CONFIG: Config = {
	port: 3000,
	db: { host: "x", port: 3306, user: "x", password: "x", database: "x" },
	fitbit: { clientId: "x", clientSecret: "x", redirectUri: "https://example.com/cb" },
	nextcloud: {
		baseUrl: "https://nc.test",
		clientId: "x",
		clientSecret: "x",
		redirectUri: "https://example.com/cb",
	},
	owntracks: { allowedTokens: ["abc12345token1", "def67890token2"] },
	sessionSecret: "x".repeat(32),
};

function buildApp(): Hono {
	const app = new Hono();
	app.route("/owntracks", owntracksRoutes(CONFIG));
	return app;
}

beforeEach(() => {
	// Stub fetch so a successful path doesn't actually call Nextcloud.
	globalThis.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

function validBody(): string {
	return JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: 1_700_000_000 });
}

describe("Owntracks route — auth gate", () => {
	it("rejects requests with no Authorization header (401)", async () => {
		const app = buildApp();
		const res = await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			body: validBody(),
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with a token not in the allowlist (403)", async () => {
		const app = buildApp();
		const res = await app.request("/owntracks/this-token-isnt-allowed/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz" },
			body: validBody(),
		});
		expect(res.status).toBe(403);
	});

	it("accepts requests with an allowed token + Authorization", async () => {
		const app = buildApp();
		const res = await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: validBody(),
		});
		// Stubbed upstream returns 200 with []; proxy adds no cmd since
		// the single fix doesn't trigger any profile change. Response is
		// JSON.
		expect(res.status).toBe(200);
	});

	it("does not reach upstream when token is rejected", async () => {
		// If the allowlist check fires correctly, fetch() never gets called.
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const app = buildApp();
		await app.request("/owntracks/wrong-token/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz" },
			body: validBody(),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not reach upstream when Authorization is missing", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const app = buildApp();
		await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			body: validBody(),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("Owntracks route — per-device state persistence across requests", () => {
	// Regression: touchStateKey was deleting entries from lastProfileByKey
	// and lastPushTsByKey to LRU-reorder them, but the caller only
	// re-inserted historyByKey. Effect: every request reset the profile
	// memory and the anti-flap timer, so the proxy re-pushed the same
	// config command on every single fix instead of once per transition.
	// Live evidence: after walking-mode was detected we saw repeated
	// `init->walking` log lines (one per ~28 s fix) instead of
	// `walking->walking no-op`.

	it("pushes a profile change at most once across a steady walking sequence", async () => {
		const app = buildApp();
		// Unique device-id so this test doesn't share module-level state
		// with the other tests in this file.
		const device = "touchstate-regression";
		const url = `/owntracks/abc12345token1/${device}`;
		const headers = { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" };
		const baseTs = 1_700_000_000;

		// Feed 6 fixes spaced 60s apart, 0.0009° north-bound (≈100m / fix).
		// effective speed 6 km/h, straightness ~1, monitoring=2 → walking
		// detection fires from fix 3 onward (span >= 120s). With the bug
		// the proxy pushes a cmd on every fix from #3; with the fix it
		// pushes exactly once on the transition and then no-ops.
		const pushCounts: number[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await app.request(url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					_type: "location",
					lat: 51.5 + i * 0.0009,
					lon: -0.1,
					tst: baseTs + i * 60,
					vel: 5,
					m: 2,
				}),
			});
			const body = (await res.json()) as Array<{ _type?: string }>;
			pushCounts.push(body.filter((m) => m._type === "cmd").length);
		}

		// Walking should have been detected and pushed at least once.
		const firstPushIdx = pushCounts.findIndex((c) => c > 0);
		expect(firstPushIdx).toBeGreaterThanOrEqual(0);

		// And after that single push, no further fix should re-push the
		// same config — anti-flap suppresses, prevProfile equals desired.
		const afterFirstPush = pushCounts.slice(firstPushIdx + 1);
		expect(afterFirstPush.every((c) => c === 0)).toBe(true);
	});
});

describe("Owntracks route — body size limit", () => {
	it("rejects payloads larger than 32 KB with 413", async () => {
		const app = buildApp();
		// 64 KB string is well over the 32 KB cap.
		const big = JSON.stringify({ pad: "x".repeat(64 * 1024) });
		const res = await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: big,
		});
		expect(res.status).toBe(413);
	});

	it("accepts payloads under the cap", async () => {
		const app = buildApp();
		const small = JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: 1_700_000_000 });
		const res = await app.request("/owntracks/abc12345token1/Pippijn", {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: small,
		});
		expect(res.status).toBe(200);
	});
});
