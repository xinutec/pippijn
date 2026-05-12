/**
 * Tests for the Nextcloud token manager.
 *
 * The critical property is the concurrent-refresh mutex: N parallel
 * callers across the expiry boundary must trigger exactly one HTTP
 * refresh, with all callers receiving the same fresh tokens. Without
 * this, concurrent dashboard requests hammer Nextcloud's token
 * endpoint and trip its brute-force protection, breaking the user's
 * connection until a manual re-auth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextcloudConfig } from "../src/nextcloud/token-manager.js";

interface NcTokenRow {
	user_id: string;
	access_token: string;
	refresh_token: string;
	expires_at: Date;
	status: string;
}

/** In-memory nc_tokens store. Reset between tests. */
const store: { rows: NcTokenRow[] } = { rows: [] };

vi.mock("../src/db/pool.js", () => {
	function makeSelectChain(table: string) {
		let capturedUserId: string | null = null;
		return {
			select: (_cols: unknown) => ({
				where: (col: string, _op: string, val: unknown) => {
					if (col === "user_id") capturedUserId = val as string;
					return {
						executeTakeFirst: async () => {
							if (table !== "nc_tokens") return null;
							return store.rows.find((r) => r.user_id === capturedUserId) ?? null;
						},
					};
				},
			}),
		};
	}

	function makeUpdateChain(table: string) {
		let pendingSet: Partial<NcTokenRow> = {};
		let capturedUserId: string | null = null;
		const chain = {
			set: (vals: Partial<NcTokenRow>) => {
				pendingSet = vals;
				return chain;
			},
			where: (col: string, _op: string, val: unknown) => {
				if (col === "user_id") capturedUserId = val as string;
				return {
					execute: async () => {
						if (table !== "nc_tokens") return;
						const row = store.rows.find((r) => r.user_id === capturedUserId);
						if (row) Object.assign(row, pendingSet);
					},
				};
			},
		};
		return chain;
	}

	const mockDb = {
		selectFrom: (table: string) => makeSelectChain(table),
		updateTable: (table: string) => makeUpdateChain(table),
	};
	return { db: () => mockDb };
});

const CONFIG: NextcloudConfig = {
	baseUrl: "https://nextcloud.test",
	clientId: "client-x",
	clientSecret: "secret-x",
};

// fetch mock
let fetchHandler: (url: string, init: RequestInit) => Promise<Response> = async () => {
	throw new Error("fetchHandler not set");
};
const fetchCalls: Array<{ url: string }> = [];

beforeEach(async () => {
	store.rows.length = 0;
	fetchCalls.length = 0;
	fetchHandler = async () => {
		throw new Error("fetchHandler not set");
	};
	globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
		const url = typeof input === "string" ? input : (input as URL).toString();
		fetchCalls.push({ url });
		return fetchHandler(url, (init ?? {}) as RequestInit);
	}) as unknown as typeof fetch;
	// Re-import to reset module-level cache between tests
	vi.resetModules();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function load() {
	return import("../src/nextcloud/token-manager.js");
}

function tokenResponse(access: string, refresh: string, expiresIn = 3600): Response {
	return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresIn }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function seedRow(overrides: Partial<NcTokenRow> = {}): NcTokenRow {
	const row: NcTokenRow = {
		user_id: "pippijn",
		access_token: "old-access",
		refresh_token: "old-refresh",
		expires_at: new Date(Date.now() - 1000), // already expired
		status: "active",
		...overrides,
	};
	store.rows.push(row);
	return row;
}

describe("getValidTokens — basic cases", () => {
	it("throws NextcloudNotLinkedError when no nc_tokens row exists", async () => {
		const m = await load();
		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.toBeInstanceOf(m.NextcloudNotLinkedError);
	});

	it("returns cached tokens without refreshing if not near expiry", async () => {
		const m = await load();
		const futureExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 min away
		seedRow({ expires_at: futureExpiry, access_token: "fresh-access" });

		const tokens = await m.getValidTokens("pippijn", CONFIG);
		expect(tokens.accessToken).toBe("fresh-access");
		expect(fetchCalls.length).toBe(0); // no refresh needed
	});

	it("refreshes when token is within 60s of expiry", async () => {
		const m = await load();
		seedRow({ expires_at: new Date(Date.now() + 30 * 1000) }); // 30s away → refresh
		fetchHandler = async () => tokenResponse("new-access", "new-refresh");

		const tokens = await m.getValidTokens("pippijn", CONFIG);
		expect(tokens.accessToken).toBe("new-access");
		expect(tokens.refreshToken).toBe("new-refresh");
		expect(fetchCalls.length).toBe(1);
	});

	it("persists refreshed tokens to DB with status='active'", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => tokenResponse("new-access", "new-refresh");

		await m.getValidTokens("pippijn", CONFIG);

		const row = store.rows[0];
		expect(row.access_token).toBe("new-access");
		expect(row.refresh_token).toBe("new-refresh");
		expect(row.status).toBe("active");
	});

	it("subsequent calls within expiry window do not refetch", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => tokenResponse("new-access", "new-refresh");

		await m.getValidTokens("pippijn", CONFIG);
		await m.getValidTokens("pippijn", CONFIG);
		await m.getValidTokens("pippijn", CONFIG);

		expect(fetchCalls.length).toBe(1); // only the first call refreshed
	});
});

describe("getValidTokens — concurrent refresh mutex", () => {
	// The whole reason this module exists. Without the mutex, N parallel
	// callers across the expiry boundary fire N concurrent refreshes —
	// Nextcloud's brute-force middleware rate-limits the IP and breaks
	// the connection.

	it("10 concurrent callers share exactly one refresh HTTP call", async () => {
		const m = await load();
		seedRow();
		let firstResolve!: (r: Response) => void;
		const firstResponse = new Promise<Response>((res) => {
			firstResolve = res;
		});
		fetchHandler = async () => firstResponse;

		// Fire 10 concurrent getValidTokens calls
		const promises = Array.from({ length: 10 }, () => m.getValidTokens("pippijn", CONFIG));

		// Let microtasks settle so every caller has run past its loadFromDb
		// await and into the refresh-phase mutex check.
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchCalls.length).toBe(1);

		// Resolve the in-flight refresh
		firstResolve(tokenResponse("new-access", "new-refresh"));

		const results = await Promise.all(promises);
		// All 10 callers got the same fresh tokens
		expect(results.every((t) => t.accessToken === "new-access")).toBe(true);
		expect(fetchCalls.length).toBe(1); // still only one
	});

	it("after refresh resolves, new callers don't trigger another refresh", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => tokenResponse("new-access", "new-refresh");

		await m.getValidTokens("pippijn", CONFIG);
		expect(fetchCalls.length).toBe(1);

		// Immediately call again — should be served from cache (fresh tokens)
		await m.getValidTokens("pippijn", CONFIG);
		expect(fetchCalls.length).toBe(1);
	});

	it("clears in-flight promise on success so future expirations re-refresh", async () => {
		// First refresh: tokens valid for 1 hour. Second call after the
		// new tokens have themselves expired should trigger another refresh.
		const m = await load();
		seedRow();

		fetchHandler = async () => tokenResponse("new-access-1", "new-refresh-1", 1); // 1 sec
		await m.getValidTokens("pippijn", CONFIG);
		expect(fetchCalls.length).toBe(1);

		// Manually expire the cached entry to avoid sleeping in the test
		store.rows[0].expires_at = new Date(Date.now() - 1000);
		// Clear in-process cache so the next call re-reads the (now-expired) DB row
		m._resetCache();

		fetchHandler = async () => tokenResponse("new-access-2", "new-refresh-2");
		const tokens = await m.getValidTokens("pippijn", CONFIG);
		expect(tokens.accessToken).toBe("new-access-2");
		expect(fetchCalls.length).toBe(2);
	});
});

describe("getValidTokens — error handling", () => {
	it("4xx from token endpoint throws NextcloudReauthRequiredError", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => new Response('{"error":"invalid_grant"}', { status: 400 });

		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.toBeInstanceOf(m.NextcloudReauthRequiredError);
	});

	it("4xx response persists status='needs_reauth' to DB", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => new Response('{"error":"invalid_grant"}', { status: 400 });

		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.toThrow();
		expect(store.rows[0].status).toBe("needs_reauth");
	});

	it("5xx response throws generic Error (transient — leave DB status alone)", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => new Response("upstream broken", { status: 502 });

		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.not.toBeInstanceOf(m.NextcloudReauthRequiredError);
		expect(store.rows[0].status).toBe("active"); // unchanged
	});

	it("DB row with status='needs_reauth' short-circuits without hitting the token endpoint", async () => {
		const m = await load();
		seedRow({ status: "needs_reauth" });

		await expect(m.getValidTokens("pippijn", CONFIG)).rejects.toBeInstanceOf(m.NextcloudReauthRequiredError);
		expect(fetchCalls.length).toBe(0); // no wasted token-endpoint call
	});

	it("error during concurrent refresh propagates to all callers", async () => {
		const m = await load();
		seedRow();
		fetchHandler = async () => new Response('{"error":"invalid_grant"}', { status: 400 });

		const promises = Array.from({ length: 5 }, () => m.getValidTokens("pippijn", CONFIG));
		const results = await Promise.allSettled(promises);

		expect(results.every((r) => r.status === "rejected")).toBe(true);
		expect(fetchCalls.length).toBe(1); // still only one fetch
	});
});

describe("invalidateTokenCache", () => {
	it("forces the next call to re-read from DB", async () => {
		const m = await load();
		seedRow({ expires_at: new Date(Date.now() + 30 * 60 * 1000), access_token: "first" });

		const t1 = await m.getValidTokens("pippijn", CONFIG);
		expect(t1.accessToken).toBe("first");

		// Mutate the DB row directly — caller would do this via the OAuth callback
		store.rows[0].access_token = "second";
		store.rows[0].expires_at = new Date(Date.now() + 60 * 60 * 1000);

		// Without invalidating, we'd still see "first" from cache
		const cached = await m.getValidTokens("pippijn", CONFIG);
		expect(cached.accessToken).toBe("first");

		m.invalidateTokenCache("pippijn");
		const fresh = await m.getValidTokens("pippijn", CONFIG);
		expect(fresh.accessToken).toBe("second");
	});
});

describe("getConnectionStatus", () => {
	it("returns 'not_linked' when no nc_tokens row exists", async () => {
		const m = await load();
		expect(await m.getConnectionStatus("pippijn")).toBe("not_linked");
	});

	it("returns 'active' for a healthy row", async () => {
		const m = await load();
		seedRow({ status: "active" });
		expect(await m.getConnectionStatus("pippijn")).toBe("active");
	});

	it("returns 'needs_reauth' when DB status reflects a failed refresh", async () => {
		const m = await load();
		seedRow({ status: "needs_reauth" });
		expect(await m.getConnectionStatus("pippijn")).toBe("needs_reauth");
	});

	it("does not hit the Nextcloud token endpoint", async () => {
		const m = await load();
		seedRow({ status: "active" });
		await m.getConnectionStatus("pippijn");
		expect(fetchCalls.length).toBe(0);
	});
});
