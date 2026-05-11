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

/** A subset of Owntracks configuration fields we may push remotely. See
 *  https://owntracks.org/booklet/tech/json/ for the full schema. Patches
 *  contain only the fields we want to change — other settings on the
 *  device are left as-is. */
export interface OwntracksConfigPatch {
	monitoring?: MonitoringMode;
	moveModeLocatorInterval?: number; // seconds between fixes in Move mode
	locatorDisplacement?: number; // metres of movement to log a fix
}

/** A coarse motion regime derived from a single velocity reading. */
export type MotionProfile = "transit-fast" | "transit" | "stationary" | null;

/**
 * Classify a velocity reading into a motion regime. Returns null for
 * the ambiguous mid-range (5-30 km/h) where the right profile depends
 * on context we don't have here (walking vs cycling vs slow drive).
 */
export function classifyMotion(speedKmh: number): MotionProfile {
	if (speedKmh > 80) return "transit-fast";
	if (speedKmh > 30) return "transit";
	if (speedKmh < 5) return "stationary";
	return null;
}

/** Owntracks settings for each motion regime. Tuned for the trade-off
 *  between fix density (better trajectory data) and battery cost:
 *
 *  - transit-fast: train / plane / fast driving. 10s gets a fix every
 *    ~280m at 100 km/h instead of every ~830m at the 30s default —
 *    meaningful for station-graph annotation on tube/rail.
 *  - transit: regular driving. 15s is dense enough to capture turns
 *    without burning battery on a long motorway run.
 *  - stationary: drop to Significant mode. Owntracks does its own
 *    motion detection there; interval/displacement only apply in Move
 *    mode anyway. */
const PROFILE_CONFIG: Record<Exclude<MotionProfile, null>, OwntracksConfigPatch> = {
	"transit-fast": { monitoring: 2, moveModeLocatorInterval: 10 },
	transit: { monitoring: 2, moveModeLocatorInterval: 15 },
	stationary: { monitoring: 1 },
};

/**
 * Decide whether to push a config patch in response to this fix.
 *
 * Returns the new motion profile and an optional patch to apply. The
 * patch is null when no command should be sent — either the speed is
 * ambiguous, or the desired profile equals what we last pushed (avoid
 * spamming the same config on every fix).
 */
export function decideRemoteConfig(
	speedKmh: number,
	lastProfile: MotionProfile,
): { profile: MotionProfile; patch: OwntracksConfigPatch | null } {
	const desired = classifyMotion(speedKmh);
	if (desired === null) return { profile: lastProfile, patch: null };
	if (desired === lastProfile) return { profile: desired, patch: null };
	return { profile: desired, patch: PROFILE_CONFIG[desired] };
}

/** Per (token,device) memory of the last-pushed motion profile. Lost on
 *  restart, which is fine — we just re-push on the next fix if the speed
 *  warrants. Keyed by both so a user with multiple devices gets independent
 *  state. */
const lastProfileByKey = new Map<string, MotionProfile>();

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
	configuration: {
		// The inner `_type: "configuration"` is required by Owntracks per
		// the docs at https://owntracks.org/booklet/tech/json/ . Without
		// it the app rejects the configuration update.
		_type: "configuration";
	} & OwntracksConfigPatch;
}

export function owntracksRoutes(config: Config): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.post("/:token/:device", async (c) => {
		const token = c.req.param("token");
		const device = c.req.param("device");
		// Read raw body once so we can both parse it for the decision and
		// forward it unchanged to PhoneTrack (matters for any signing /
		// content-length consistency PhoneTrack may care about).
		const rawBody = await c.req.text();
		let payload: OwntracksLocation | OwntracksLocation[];
		try {
			payload = JSON.parse(rawBody);
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}

		// Forward verbatim to Nextcloud PhoneTrack. Owntracks sends HTTP
		// Basic Auth (username/password configured in the app); PhoneTrack
		// relies on that for write authorisation, so we pass it through
		// along with the body. We also pass through the User-Agent so any
		// PhoneTrack-side logs / rate-limiting attribute correctly to the
		// real client.
		const phonetrackUrl = `${config.nextcloud.baseUrl}/apps/phonetrack/log/owntracks/${token}/${device}`;
		const forwardedHeaders: Record<string, string> = {
			"Content-Type": c.req.header("Content-Type") ?? "application/json",
		};
		const auth = c.req.header("Authorization");
		if (auth) forwardedHeaders.Authorization = auth;
		const ua = c.req.header("User-Agent");
		if (ua) forwardedHeaders["User-Agent"] = ua;
		const upstreamRes = await fetch(phonetrackUrl, {
			method: "POST",
			headers: forwardedHeaders,
			body: rawBody,
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
		const { profile, patch } = decideRemoteConfig(maxVel, lastProfileByKey.get(stateKey) ?? null);

		// Preserve PhoneTrack's response body. PhoneTrack returns a JSON
		// array containing a "you are your own friend" location-echo
		// message that Owntracks uses to render the user's own marker on
		// the in-app map. Without this passthrough the marker disappears.
		// We then append our own cmd messages to that array.
		let baseResponse: unknown[] = [];
		try {
			const upstreamBody = await upstreamRes.text();
			if (upstreamBody.trim().length > 0) {
				const parsed = JSON.parse(upstreamBody);
				if (Array.isArray(parsed)) baseResponse = parsed;
			}
		} catch {
			// Upstream returned a non-JSON body; nothing to pass through.
		}

		if (patch !== null) {
			lastProfileByKey.set(stateKey, profile);
			baseResponse.push({
				_type: "cmd",
				action: "setConfiguration",
				configuration: { _type: "configuration", ...patch },
			} satisfies OwntracksCommand);
		}
		return c.json(baseResponse);
	});

	return app;
}
