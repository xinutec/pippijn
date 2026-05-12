import { NextcloudClient } from "./client.js";
import { getValidTokens } from "./token-manager.js";

// Re-export for callers that catch these specifically. The actual class
// definitions live in `token-manager.ts` where the throwers live.
export { NextcloudNotLinkedError, NextcloudReauthRequiredError } from "./token-manager.js";

export interface NextcloudConfig {
	nextcloud: {
		baseUrl: string;
		clientId: string;
		clientSecret: string;
	};
}

export interface RawTrackPoint {
	ts: number;
	lat: number;
	lon: number;
	altitude: number | null;
	speed: number | null;
	accuracy: number | null;
	battery: number | null;
}

/** Pre-built Nextcloud client + session/device list for a single user.
 *  Build once via `openPhoneTrack` and reuse across many `fetchTrackPointsRange`
 *  calls — the multi-week backfill in `cli/refresh-focus-places.ts` would
 *  otherwise pay the token-lookup + client-construction + sessions-list cost
 *  on every chunk (26× for a 180-day window). */
export interface PhoneTrackContext {
	client: NextcloudClient;
	sessions: Record<string, { id: number; name: string; devices?: Record<string, { id: number; name: string }> }>;
}

export async function openPhoneTrack(config: NextcloudConfig, userId: string): Promise<PhoneTrackContext> {
	// Pre-flight: validates tokens exist + are not in `needs_reauth`
	// state, refreshes if expired. All concurrent callers share one
	// refresh via the per-user mutex in the token manager.
	await getValidTokens(userId, config.nextcloud);
	const client = new NextcloudClient(userId, config.nextcloud);
	const sessions = await client.get<PhoneTrackContext["sessions"]>("/index.php/apps/phonetrack/sessions");
	return { client, sessions };
}

/** Fetch points using a pre-built context. Use this when fetching many
 *  ranges for the same user — the context only does one DB lookup +
 *  one sessions-list call up front. */
export async function fetchTrackPointsRange(
	ctx: PhoneTrackContext,
	date: string,
	nextDay: string,
): Promise<RawTrackPoint[]> {
	const minTs = Math.floor(new Date(date).getTime() / 1000);
	const maxTs = Math.floor(new Date(nextDay).getTime() / 1000);
	const allPoints: RawTrackPoint[] = [];

	for (const session of Object.values(ctx.sessions)) {
		if (!session.devices) continue;
		for (const device of Object.values(session.devices)) {
			try {
				const points = await ctx.client.get<
					Array<{
						timestamp: number;
						lat: number;
						lon: number;
						altitude: number | null;
						speed: number | null;
						accuracy: number | null;
						batterylevel: number | null;
					}>
				>(
					`/index.php/apps/phonetrack/session/${session.id}/device/${device.id}/points?minTimestamp=${minTs}&maxTimestamp=${maxTs}&maxPoints=10000`,
				);
				if (Array.isArray(points)) {
					for (const p of points) {
						allPoints.push({
							ts: p.timestamp,
							lat: p.lat,
							lon: p.lon,
							altitude: p.altitude,
							speed: p.speed,
							accuracy: p.accuracy,
							battery: p.batterylevel,
						});
					}
				}
			} catch {
				// skip devices that fail
			}
		}
	}

	allPoints.sort((a, b) => a.ts - b.ts);
	return allPoints;
}

/** One-shot fetch: build a context and use it for a single range. Convenience
 *  for the API route which only ever fetches one day at a time. */
export async function fetchTrackPoints(
	config: NextcloudConfig,
	userId: string,
	date: string,
	nextDay: string,
): Promise<RawTrackPoint[]> {
	const ctx = await openPhoneTrack(config, userId);
	return fetchTrackPointsRange(ctx, date, nextDay);
}
