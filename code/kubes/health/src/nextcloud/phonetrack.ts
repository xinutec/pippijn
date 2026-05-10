import { db } from "../db/pool.js";
import { NextcloudClient } from "./client.js";

export interface NextcloudConfig {
	nextcloud: {
		baseUrl: string;
		clientId: string;
		clientSecret: string;
	};
}

/** Thrown when the user has no `nc_tokens` row, i.e. they have not yet
 *  linked a Nextcloud account. Callers can catch this specifically to
 *  degrade gracefully (e.g. return an empty timeline instead of HTTP 400). */
export class NextcloudNotLinkedError extends Error {
	constructor() {
		super("Nextcloud not linked");
		this.name = "NextcloudNotLinkedError";
	}
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
	const ncToken = await db()
		.selectFrom("nc_tokens")
		.select(["access_token", "refresh_token", "expires_at"])
		.where("user_id", "=", userId)
		.executeTakeFirst();

	if (!ncToken) {
		throw new NextcloudNotLinkedError();
	}

	const client = new NextcloudClient({
		accessToken: ncToken.access_token,
		refreshToken: ncToken.refresh_token,
		expiresAt: new Date(ncToken.expires_at).getTime(),
		baseUrl: config.nextcloud.baseUrl,
		clientId: config.nextcloud.clientId,
		clientSecret: config.nextcloud.clientSecret,
		onTokenRefresh: async (accessToken, refreshToken, expiresIn) => {
			await db()
				.updateTable("nc_tokens")
				.set({
					access_token: accessToken,
					refresh_token: refreshToken,
					expires_at: new Date(Date.now() + expiresIn * 1000),
				})
				.where("user_id", "=", userId)
				.execute();
		},
	});

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
