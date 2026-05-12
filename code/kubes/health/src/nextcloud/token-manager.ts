/**
 * Centralised Nextcloud OAuth token manager.
 *
 * # Why this exists
 *
 * Every dashboard page load fires multiple API calls in parallel
 * (sleep + velocity + locations + devices + …). Each one used to
 * construct its own NextcloudClient with its own copy of the tokens.
 * When the access token expired, all those clients independently
 * called `/oauth2/api/v1/token` with the same refresh token —
 * 5–10 concurrent POSTs to the same endpoint.
 *
 * Three things go wrong with that:
 *
 *   1. Nextcloud's brute-force protection flags the IP after enough
 *      attempts in 12 hours (~37 attempts) and starts returning
 *      `400 invalid_request` to every subsequent refresh, regardless
 *      of validity. Recovery requires a full re-auth.
 *   2. Nextcloud's OAuth refresh-token rotation invalidates the old
 *      refresh token as soon as the first concurrent refresh succeeds.
 *      The others then send a refresh token that no longer exists →
 *      genuine `invalid_grant` errors stack on top of (1).
 *   3. Even without those, the wasted round-trips slow down page load
 *      (refresh takes ~600 ms on this NC instance).
 *
 * # What it does
 *
 * Holds an in-process per-user cache of `{ tokens, refreshPromise? }`.
 * The first caller whose access token is within 60 s of expiring kicks
 * off the refresh and stores the promise; every other concurrent caller
 * awaits that same promise. After the refresh resolves, all callers
 * receive the new tokens; the promise is cleared from the cache so
 * subsequent calls re-evaluate.
 *
 * The cache is also the place where reauth-required state is tracked.
 * A 4xx from the token endpoint is permanent (refresh token is dead);
 * we mark the DB row as `needs_reauth`, throw a typed error, and
 * `/api/me` reports this to the UI. A network error or 5xx is treated
 * as transient — we drop the in-flight promise so the next call retries.
 *
 * # State
 *
 *   - In-process: `Map<userId, CacheEntry>` (per-pod; rolling restarts
 *     are fine — first request after restart reads from DB)
 *   - DB: `nc_tokens` table with access/refresh tokens, expiry, and
 *     `status` column ("active" | "needs_reauth")
 */

import { db } from "../db/pool.js";

const REFRESH_SKEW_MS = 60 * 1000;

interface NcTokens {
	accessToken: string;
	refreshToken: string;
	expiresAtMs: number;
}

interface CacheEntry {
	tokens: NcTokens;
	refreshPromise: Promise<NcTokens> | null;
}

const cache = new Map<string, CacheEntry>();
/** In-flight cache loads keyed by userId. Distinct from the refresh
 *  mutex: this dedupes the *initial* DB read when N concurrent callers
 *  hit the proxy with a cold cache. Without it, every caller creates
 *  its own CacheEntry and the refresh-phase mutex doesn't apply. */
const loadingPromises = new Map<string, Promise<CacheEntry>>();

export interface NextcloudConfig {
	baseUrl: string;
	clientId: string;
	clientSecret: string;
}

/** Thrown when the user has no `nc_tokens` row, i.e. they have not yet
 *  linked a Nextcloud account. */
export class NextcloudNotLinkedError extends Error {
	constructor() {
		super("Nextcloud not linked");
		this.name = "NextcloudNotLinkedError";
	}
}

/** Thrown when a refresh attempt was *permanently* rejected by Nextcloud
 *  — refresh token revoked, expired, rate-limited, or the OAuth client
 *  rotated. The user has to go through `/login` again. Distinct from
 *  transient network/5xx errors which the caller may retry. */
export class NextcloudReauthRequiredError extends Error {
	constructor(
		public readonly upstreamStatus: number,
		public readonly upstreamBody: string,
	) {
		super(`Nextcloud refresh rejected (${upstreamStatus}): ${upstreamBody}`);
		this.name = "NextcloudReauthRequiredError";
	}
}

async function loadFromDb(userId: string): Promise<{ tokens: NcTokens; status: string } | null> {
	const row = await db()
		.selectFrom("nc_tokens")
		.select(["access_token", "refresh_token", "expires_at", "status"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) return null;
	return {
		tokens: {
			accessToken: row.access_token,
			refreshToken: row.refresh_token,
			expiresAtMs: new Date(row.expires_at).getTime(),
		},
		status: row.status,
	};
}

async function persistRefreshedTokens(userId: string, tokens: NcTokens): Promise<void> {
	await db()
		.updateTable("nc_tokens")
		.set({
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken,
			expires_at: new Date(tokens.expiresAtMs),
			status: "active",
		})
		.where("user_id", "=", userId)
		.execute();
}

async function markReauthRequired(userId: string): Promise<void> {
	await db().updateTable("nc_tokens").set({ status: "needs_reauth" }).where("user_id", "=", userId).execute();
}

async function doRefresh(userId: string, current: NcTokens, config: NextcloudConfig): Promise<NcTokens> {
	const res = await fetch(`${config.baseUrl}/index.php/apps/oauth2/api/v1/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: current.refreshToken,
			client_id: config.clientId,
			client_secret: config.clientSecret,
		}),
	});

	const body = await res.text();
	if (!res.ok) {
		// 4xx = refresh token is dead (rejected, rate-limited, expired).
		// Permanent — flip the DB status so /api/me surfaces "needs_reauth"
		// to the UI without us having to retry on every subsequent call.
		// 5xx / network errors caught at the outer fetch boundary are
		// thrown as generic Error and treated as transient by the caller.
		if (res.status >= 400 && res.status < 500) {
			await markReauthRequired(userId);
			throw new NextcloudReauthRequiredError(res.status, body);
		}
		throw new Error(`Nextcloud token refresh failed: ${res.status} ${body}`);
	}

	const data = JSON.parse(body) as { access_token: string; refresh_token: string; expires_in?: number };
	const expiresIn = data.expires_in ?? 3600;
	const newTokens: NcTokens = {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAtMs: Date.now() + expiresIn * 1000,
	};
	await persistRefreshedTokens(userId, newTokens);
	console.log(`Nextcloud token refreshed for user=${userId} (expires in ${expiresIn}s)`);
	return newTokens;
}

/**
 * Get a valid access token for the user, refreshing if necessary.
 *
 * Concurrent callers race-safely: the first to find the cache empty or
 * the token near expiry initiates a refresh and stores a Promise in
 * the cache; everyone else awaits that same Promise. Once it settles,
 * the Promise is cleared and subsequent calls re-evaluate the freshly
 * stored tokens against the clock.
 *
 * Throws:
 *   - `NextcloudNotLinkedError` — no row in nc_tokens
 *   - `NextcloudReauthRequiredError` — refresh rejected by Nextcloud
 *   - generic `Error` — network/5xx (caller may retry)
 */
/** Load or fetch the cache entry for this user, deduplicating concurrent
 *  cold-cache reads. All concurrent callers awaiting the same userId
 *  resolve to the same CacheEntry object so the refresh-phase mutex
 *  (keyed on `entry.refreshPromise`) actually deduplicates. */
async function getOrLoadEntry(userId: string): Promise<CacheEntry> {
	const cached = cache.get(userId);
	if (cached) return cached;

	const inFlight = loadingPromises.get(userId);
	if (inFlight) return inFlight;

	const promise = (async () => {
		const loaded = await loadFromDb(userId);
		if (!loaded) throw new NextcloudNotLinkedError();
		// Short-circuit: a previously-failed refresh already flagged this
		// row as needing reauth. Don't bother hitting the token endpoint
		// just to collect another rate-limit hit on the brute-force counter.
		if (loaded.status === "needs_reauth") {
			throw new NextcloudReauthRequiredError(0, "cached: needs_reauth");
		}
		const entry: CacheEntry = { tokens: loaded.tokens, refreshPromise: null };
		cache.set(userId, entry);
		return entry;
	})().finally(() => {
		loadingPromises.delete(userId);
	});
	loadingPromises.set(userId, promise);
	return promise;
}

export async function getValidTokens(userId: string, config: NextcloudConfig): Promise<NcTokens> {
	const entry = await getOrLoadEntry(userId);

	if (Date.now() < entry.tokens.expiresAtMs - REFRESH_SKEW_MS) {
		return entry.tokens;
	}

	if (entry.refreshPromise) {
		return entry.refreshPromise;
	}

	const refreshPromise = doRefresh(userId, entry.tokens, config)
		.then((newTokens) => {
			cache.set(userId, { tokens: newTokens, refreshPromise: null });
			return newTokens;
		})
		.catch((err) => {
			// Drop the in-flight promise so future callers can retry.
			// Transient errors → a retry might succeed; reauth-required →
			// we've already persisted the status to DB and the next call
			// short-circuits via the DB read in getOrLoadEntry (after the
			// cache is invalidated by /auth/callback).
			const current = cache.get(userId);
			if (current) cache.set(userId, { ...current, refreshPromise: null });
			throw err;
		});

	entry.refreshPromise = refreshPromise;
	cache.set(userId, entry);
	return refreshPromise;
}

/** Drop the cached entry for this user. Called from `/auth/callback`
 *  after writing fresh tokens so the next API call picks them up from
 *  DB instead of the (now stale) in-process cache. */
export function invalidateTokenCache(userId: string): void {
	cache.delete(userId);
}

export type ConnectionStatus = "active" | "needs_reauth" | "not_linked";

/** Report current connection state from DB. Cheap — does not hit the
 *  Nextcloud token endpoint, so safe to call from `/api/me`. */
export async function getConnectionStatus(userId: string): Promise<ConnectionStatus> {
	const row = await db().selectFrom("nc_tokens").select(["status"]).where("user_id", "=", userId).executeTakeFirst();
	if (!row) return "not_linked";
	if (row.status === "needs_reauth") return "needs_reauth";
	return "active";
}

/** Test seam: clear all cached entries. Production code should use
 *  `invalidateTokenCache(userId)` instead. */
export function _resetCache(): void {
	cache.clear();
	loadingPromises.clear();
}
