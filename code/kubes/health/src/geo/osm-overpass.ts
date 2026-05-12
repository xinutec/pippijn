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

/** Maximum number of concurrent Overpass fetches across the whole
 *  process. The local-mirror cold-start fans out 4 fetches × N
 *  velocity segments in parallel, each loading 5-50 MB JSON. Even
 *  at a 512 MB pod limit, ~5 concurrent landmark responses OOM. A
 *  conservative cap of 2 bounds the peak memory at ~2× the largest
 *  response — well within budget — with a small wall-time cost on
 *  cold-start that's invisible once the mirror is populated. */
// Concurrency 1: full serialization. A single 50 MB Overpass response
// peaks at ~200 MB during res.json() parsing (V8 stores raw string +
// parsed tree). Two in flight at once OOMs a 512 MB pod. Wall-time
// cost on cold-start is bounded; once the mirror is populated the
// semaphore never blocks anything.
const OVERPASS_CONCURRENCY = 1;
let inFlight = 0;
const queue: Array<() => void> = [];
function acquire(): Promise<void> {
	if (inFlight < OVERPASS_CONCURRENCY) {
		inFlight++;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		queue.push(() => {
			inFlight++;
			resolve();
		});
	});
}
function release(): void {
	inFlight--;
	const next = queue.shift();
	if (next) next();
}

/**
 * POST a single Overpass query body to each mirror in turn until one
 * returns a successful response. Each mirror gets up to
 * `OVERPASS_TIMEOUT_MS` before we abort and try the next. Throws only
 * if every mirror fails — caller decides whether to negative-cache,
 * skip, or surface the error.
 */
export async function overpassFetch(body: string): Promise<Response> {
	await acquire();
	try {
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
				// Non-OK: only fall through on transient (5xx) or
				// rate-limited (429). 4xx that aren't 429 are permanent
				// (bad query); don't waste mirrors on those.
				if (res.status !== 429 && res.status < 500) return res;
				lastErr = new Error(`Overpass ${url} returned ${res.status}`);
			} catch (e) {
				lastErr = e;
			} finally {
				clearTimeout(timer);
			}
		}
		throw lastErr ?? new Error("All Overpass mirrors failed");
	} finally {
		release();
	}
}
