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

// The route reads focus_places to gate the long-stay demote. We don't
// have a real DB in this test, so stub the loader to return no focus
// places — which is the "transient location everywhere" default and
// keeps these tests focused on the auth gate / body limit / state
// persistence concerns that they were originally written for.
vi.mock("../src/routes/owntracks-focus-cache.js", () => ({
	getFocusPlacesForGating: async () => [],
	_resetFocusCache: () => {},
}));

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

describe("Owntracks route — always-push", () => {
	// The proxy attaches a setConfiguration cmd to every fix response.
	// The phone applies it idempotently. There's no anti-flap timer
	// and no "did this change from last time" dedup — bandwidth is
	// negligible, and pushing every time means a transient state loss
	// on either side recovers on the very next fix.

	it("attaches one cmd to every fix in a steady walking sequence", async () => {
		const app = buildApp();
		const device = "alwayspush-walking";
		const url = `/owntracks/abc12345token1/${device}`;
		const headers = { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" };
		const baseTs = 1_700_000_000;

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

		// Exactly one cmd per fix, no more no less.
		expect(pushCounts).toEqual([1, 1, 1, 1, 1, 1]);
	});

	it("the very first fix already carries a cmd (factory-default stationary)", async () => {
		const app = buildApp();
		const device = "alwayspush-firstfix";
		const res = await app.request(`/owntracks/abc12345token1/${device}`, {
			method: "POST",
			headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
			body: JSON.stringify({ _type: "location", lat: 51.5, lon: -0.1, tst: 1_700_000_000 }),
		});
		const body = (await res.json()) as Array<{ _type?: string; configuration?: { monitoring?: number } }>;
		const cmds = body.filter((m) => m._type === "cmd");
		expect(cmds).toHaveLength(1);
		// No history, no lastProfile → resolves to stationary (monitoring=1).
		expect(cmds[0].configuration?.monitoring).toBe(1);
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
