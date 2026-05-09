import type { Config } from "../config.js";
import { db } from "../db/pool.js";
import { NextcloudClient } from "./client.js";

export interface RawTrackPoint {
	ts: number;
	lat: number;
	lon: number;
	altitude: number | null;
	speed: number | null;
	accuracy: number | null;
	battery: number | null;
}

/**
 * Fetch all PhoneTrack points for a user on a given date.
 * Uses the user's stored Nextcloud OAuth tokens.
 */
export async function fetchTrackPoints(
	config: Config,
	userId: string,
	date: string,
	nextDay: string,
): Promise<RawTrackPoint[]> {
	const ncToken = await db()
		.selectFrom("nc_tokens")
		.select(["access_token", "refresh_token", "expires_at"])
		.where("user_id", "=", userId)
		.executeTakeFirst();

	if (!ncToken) {
		throw new Error("Nextcloud not linked");
	}

	const nc = new NextcloudClient({
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

	const sessions = await nc.get<
		Record<string, { id: number; name: string; devices?: Record<string, { id: number; name: string }> }>
	>("/index.php/apps/phonetrack/sessions");

	const minTs = Math.floor(new Date(date).getTime() / 1000);
	const maxTs = Math.floor(new Date(nextDay).getTime() / 1000);
	const allPoints: RawTrackPoint[] = [];

	for (const session of Object.values(sessions)) {
		if (!session.devices) continue;
		for (const device of Object.values(session.devices)) {
			try {
				const points = await nc.get<
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
