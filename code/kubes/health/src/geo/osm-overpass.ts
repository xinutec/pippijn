/**
 * Shared Overpass + Nominatim fetcher used by `osm.ts` (cache-based
 * Nominatim path) and `osm-local.ts` (spatially-indexed mirror).
 *
 * Two mirrors, each with a hard timeout so a hung connection-refused
 * doesn't sit for minutes blocking the velocity pipeline.
 */

export const USER_AGENT = "health.xinutec.org (pippijn@xinutec.org)";

const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

// 4s was fine for point-radius queries (small responses); the local
// mirror's 10 km bbox queries — especially landmark + highway in dense
// urban areas — can legitimately take 10+ seconds. 20s keeps us under
// the Overpass server-side `[timeout:25]` while leaving headroom for
// a hung connection to abort and fall through to the mirror.
const OVERPASS_TIMEOUT_MS = 20_000;

/**
 * POST a single Overpass query body to each mirror in turn until one
 * returns a successful response. Each mirror gets up to
 * `OVERPASS_TIMEOUT_MS` before we abort and try the next. Throws only
 * if every mirror fails — caller decides whether to negative-cache,
 * skip, or surface the error.
 */
export async function overpassFetch(body: string): Promise<Response> {
	let lastErr: unknown;
	for (const url of OVERPASS_URLS) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
				body,
				signal: controller.signal,
			});
			if (res.ok) return res;
			// Non-OK: only fall through on transient (5xx) or rate-limited
			// (429). 4xx that aren't 429 are permanent (bad query); don't
			// waste mirrors on those.
			if (res.status !== 429 && res.status < 500) return res;
			lastErr = new Error(`Overpass ${url} returned ${res.status}`);
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr ?? new Error("All Overpass mirrors failed");
}
