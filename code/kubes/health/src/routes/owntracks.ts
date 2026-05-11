/**
 * Owntracks Android → Nextcloud PhoneTrack proxy with server-side remote
 * configuration.
 *
 * The Android Owntracks app posts location updates over HTTP. Normally
 * this points directly at Nextcloud's PhoneTrack endpoint. Pointing it
 * at this proxy instead lets us:
 *
 *   1. Forward the payload to PhoneTrack unchanged (PhoneTrack remains
 *      the source of truth for location history — we don't duplicate
 *      storage here).
 *   2. Decide server-side whether to push remote-configuration commands
 *      back to the phone, using the much richer context we have:
 *      focus_places, mode signatures, daily activity rhythms.
 *
 * The decision-making is intentionally simple in v1 (velocity-based
 * mode flipping). Once shipped, additional rules can be layered in:
 * geofence-based (Home / Work clusters), schedule-based (typical
 * commute window), or battery-aware.
 *
 * Owntracks "monitoring" mode values (Android):
 *    0 = Manual    (no automatic reporting; user pushes a button)
 *    1 = Significant (~100m or motion-triggered; battery-efficient)
 *    2 = Move      (continuous fixes every N seconds; high fidelity)
 *
 * The HTTP response body to a location POST may be a JSON array of
 * messages; commands are messages with `_type: "cmd"`. See:
 *   https://owntracks.org/booklet/features/remoteconfig/
 */

import { Hono } from "hono";
import type { Config } from "../config.js";
import type { AppEnv } from "../env.js";

export type MonitoringMode = 0 | 1 | 2;

/** Speed (km/h) above which we treat the user as "clearly in transit." */
const TRANSIT_SPEED_KMH = 30;

/** Speed (km/h) below which we treat the user as "clearly not moving." */
const STATIONARY_SPEED_KMH = 5;

/**
 * Decide whether to push a remote-config command in response to this fix.
 *
 * Returns the desired monitoring mode, or null if no command should be
 * sent (either no clear signal, or the desired mode equals what we last
 * pushed). Pure function so the rule is unit-testable independent of HTTP
 * plumbing.
 */
export function decideMonitoringCommand(speedKmh: number, lastMode: MonitoringMode | null): MonitoringMode | null {
	let desired: MonitoringMode | null;
	if (speedKmh > TRANSIT_SPEED_KMH) desired = 2;
	else if (speedKmh < STATIONARY_SPEED_KMH) desired = 1;
	else desired = null;
	if (desired === null) return null;
	if (desired === lastMode) return null;
	return desired;
}

/** Per (token,device) memory of the last-pushed monitoring mode. Lost on
 *  restart, which is fine — we just re-push on the next fix if the speed
 *  warrants. Keyed by both so a user with multiple devices gets independent
 *  state. */
const lastModeByKey = new Map<string, MonitoringMode>();

/** Owntracks location-message shape (subset of fields we care about). */
interface OwntracksLocation {
	_type?: string;
	vel?: number; // speed in km/h
	lat?: number;
	lon?: number;
	acc?: number;
	tst?: number;
}

interface OwntracksCommand {
	_type: "cmd";
	action: "setConfiguration";
	configuration: { monitoring: MonitoringMode };
}

export function owntracksRoutes(config: Config): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.post("/:token/:device", async (c) => {
		const token = c.req.param("token");
		const device = c.req.param("device");
		const payload = await c.req.json<OwntracksLocation | OwntracksLocation[]>().catch(() => null);
		if (payload === null) return c.json({ error: "invalid json" }, 400);

		// Forward verbatim to Nextcloud PhoneTrack. The user's existing
		// session token + device name (in URL) is what authorises the
		// write at PhoneTrack; we don't add or strip credentials.
		const phonetrackUrl = `${config.nextcloud.baseUrl}/apps/phonetrack/log/owntracks/${token}/${device}`;
		const upstreamRes = await fetch(phonetrackUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		}).catch((err: unknown) => {
			console.warn(`Owntracks proxy: PhoneTrack POST failed for token ${token}: ${err}`);
			return null;
		});

		// If PhoneTrack rejected the write, propagate the status so
		// Owntracks retries. No remote-config command in that case — we
		// want to focus on the data integrity first.
		if (upstreamRes === null) return c.json({ error: "upstream unreachable" }, 502);
		if (!upstreamRes.ok) return c.json({ error: "upstream rejected" }, upstreamRes.status as 400 | 502);

		// Decide remote-config command based on this fix's velocity.
		// Owntracks payloads can be a single message or an array; we look
		// at the highest velocity reported in the batch.
		const messages = Array.isArray(payload) ? payload : [payload];
		const maxVel = messages.reduce((m, msg) => (msg.vel !== undefined && msg.vel > m ? msg.vel : m), 0);
		const stateKey = `${token}/${device}`;
		const desired = decideMonitoringCommand(maxVel, lastModeByKey.get(stateKey) ?? null);

		const response: OwntracksCommand[] = [];
		if (desired !== null) {
			lastModeByKey.set(stateKey, desired);
			response.push({
				_type: "cmd",
				action: "setConfiguration",
				configuration: { monitoring: desired },
			});
		}
		return c.json(response);
	});

	return app;
}
