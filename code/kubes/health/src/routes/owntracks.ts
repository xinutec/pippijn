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
 * # Decision architecture
 *
 * Each Owntracks POST runs through one decision pipeline that turns the
 * recent fix history (plus the current fix's metadata) into a set of
 * named signals, then runs the signals past four explicit transition
 * predicates in priority order:
 *
 *   1. `escalateOnHighSpeed` — single-fix or computed velocity > 30 km/h
 *      flips us straight into transit/transit-fast. Fastest reaction
 *      when the user boards a vehicle. Doesn't depend on history.
 *   2. `escalateFromSignificant` — when the phone is in Significant
 *      ("energy saving") mode, motion evidence (closely-spaced fixes,
 *      user-action trigger, displacement above walking-pace) escalates
 *      us into a Move-mode profile. Refines to walking if history
 *      supports it; otherwise pushes a generic transit profile.
 *   3. `refineInMove` — when the phone is in Move mode and history is
 *      rich enough, pick the precise profile from effective speed and
 *      straightness (transit-fast / transit / walking).
 *   4. `demoteAfterStop` — only after 10 minutes of sustained
 *      low-speed history do we push the phone back to Significant.
 *      Single weird-zero fixes (tube tunnel, ping messages) get ignored.
 *
 * Pushes are also gated by a 2-minute anti-flap window so multiple
 * marginal signals can't oscillate the phone's mode. High-confidence
 * single-fix escalation (reported `vel` > 30 km/h) bypasses the window
 * — boarding a train shouldn't be delayed by our own throttling.
 *
 * # Owntracks monitoring modes
 *    0 = Manual    (no automatic reporting; user pushes a button)
 *    1 = Significant (~100m or motion-triggered; battery-efficient)
 *    2 = Move      (continuous fixes every N seconds; high fidelity)
 *
 * # Owntracks trigger types (`t` field)
 *    p = ping (heartbeat)         u = userAction (manual)
 *    c = circular geofence        t = timer (Android scheduled)
 *    b = beacon                   v = monitoring level changed
 *    r = reportLocation command
 *
 * See https://owntracks.org/booklet/tech/json/ for the full schema and
 * https://owntracks.org/booklet/features/remoteconfig/ for the command
 * protocol we use on the response path.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Config } from "../config.js";
import type { AppEnv } from "../env.js";
import { haversineMeters } from "../geo/place-snap.js";

/** Owntracks payloads are tiny — a typical batched fix is well under
 *  1 KB. Cap at 32 KB so a misconfigured client (or a hostile probe)
 *  can't OOM the proxy by streaming megabytes of body. */
const MAX_BODY_BYTES = 32 * 1024;

// ============================================================================
// Constants
// ============================================================================

const MIN_WALKING_FIXES = 3;
const WALKING_MIN_KMH = 2;
const WALKING_MAX_KMH = 8;
const WALKING_MIN_STRAIGHTNESS = 0.5;
const TRANSIT_KMH = 30;
const TRANSIT_FAST_KMH = 80;

/** How far back the walking / refinement window reaches. Long enough to
 *  gather Significant-mode fixes (which can wait minutes between fixes),
 *  short enough that yesterday's walk doesn't leak in. */
export const HISTORY_MAX_AGE_SEC = 600;

/** Minimum history span before in-Move refinement engages. A short burst
 *  of fixes right after escalation can't yet support a confident profile;
 *  wait for ~2 minutes of trajectory first. */
const MIN_HISTORY_SPAN_FOR_REFINE_SEC = 120;

/** Minimum history span before we'll demote to Significant. Demotion is
 *  the most expensive transition (phone gives up the warm GPS), so we
 *  require 10 minutes of sustained low-speed evidence — cafe stops,
 *  office arrivals, evenings at home — before flipping. */
const MIN_STATIONARY_DEMOTE_SEC = 600;

/** Gap threshold for the "phone's motion sensor fired" inference: in
 *  Significant mode, Owntracks Android schedules a fix roughly every
 *  15 minutes, and emits extras when motion is detected. Two fixes
 *  arriving < 5 minutes apart in Significant = real motion. */
const SIGNIFICANT_MODE_MOTION_GAP_SEC = 300;

/** Don't push a second remote-config command within this window after the
 *  previous push — prevents oscillation when multiple marginal signals
 *  disagree near a boundary. High-confidence single-fix escalations
 *  bypass this throttle (see {@link decideRemoteConfig}). */
const ANTI_FLAP_WINDOW_SEC = 120;

// ============================================================================
// Types
// ============================================================================

export type MonitoringMode = 0 | 1 | 2;

/** Owntracks configuration patch. Partial — only fields we want to
 *  change. See https://owntracks.org/booklet/tech/json/ . */
export interface OwntracksConfigPatch {
	monitoring?: MonitoringMode;
	moveModeLocatorInterval?: number;
	locatorDisplacement?: number;
}

/** A coarse motion regime. `walking` is detected from a multi-fix
 *  history rather than a single velocity reading. */
export type MotionProfile = "transit-fast" | "transit" | "walking" | "stationary" | null;

/** A retained GPS fix. Extra fields (`vel`, `trigger`, `monitoringMode`)
 *  are optional so call sites that only have positional data can still
 *  build records — but production payloads from Owntracks Android
 *  carry all of them and the decision pipeline uses them. */
export interface FixRecord {
	ts: number; // unix seconds
	lat: number;
	lon: number;
	/** Velocity reported in the fix, km/h. Often null in Significant mode. */
	vel?: number | null;
	/** Owntracks `t` field — trigger type single char. */
	trigger?: string | null;
	/** Owntracks `m` field — current monitoring mode (1=Significant, 2=Move). */
	monitoringMode?: number | null;
}

/** All the signals derived from a fix history that the decision pipeline
 *  consumes. Each signal has well-defined semantics including how to
 *  interpret it when history is sparse. */
export interface DecisionSignals {
	/** Velocity reported in the latest fix (0 if missing). */
	reportedVelKmh: number;
	/** Velocity computed from displacement between the latest two fixes
	 *  (0 if only one fix). Robust to a missing `vel` field. */
	computedVelKmh: number;
	/** Time between the latest two fixes (0 if only one fix). */
	gapSinceLastFixSec: number;
	/** Effective speed across the whole history window (km/h). */
	effectiveSpeedKmh: number;
	/** Straightness ratio across the whole history window (0..1). */
	straightness: number;
	/** Time span covered by the history (seconds). */
	historySpanSec: number;
	/** Trigger type from the latest fix's `t` field. */
	trigger: string | null;
	/** Monitoring mode from the latest fix's `m` field. */
	monitoringMode: number | null;
}

/** Owntracks location-message payload shape (subset we care about). */
interface OwntracksLocation {
	_type?: string;
	vel?: number;
	lat?: number;
	lon?: number;
	acc?: number;
	tst?: number;
	t?: string;
	m?: number;
}

interface OwntracksCommand {
	_type: "cmd";
	action: "setConfiguration";
	configuration: {
		_type: "configuration";
	} & OwntracksConfigPatch;
}

// ============================================================================
// Pure geometry helpers
// ============================================================================

/**
 * Classify a single velocity reading into a coarse motion regime. Used as
 * the single-fix escalation signal. Returns null for the ambiguous
 * mid-range (5-30 km/h) and the walking band (< 5 km/h) where multi-fix
 * history is needed to disambiguate walking from drift.
 */
export function classifyMotion(speedKmh: number): MotionProfile {
	if (speedKmh > TRANSIT_FAST_KMH) return "transit-fast";
	if (speedKmh > TRANSIT_KMH) return "transit";
	if (speedKmh < 5) return "stationary";
	return null;
}

/** Drop fixes older than `nowSec - maxAgeSec`. Inclusive at the boundary. */
export function pruneFixHistory(history: FixRecord[], maxAgeSec: number, nowSec: number): FixRecord[] {
	const cutoff = nowSec - maxAgeSec;
	return history.filter((f) => f.ts >= cutoff);
}

function pathDistanceM(history: FixRecord[]): number {
	let d = 0;
	for (let i = 1; i < history.length; i++) {
		d += haversineMeters(history[i - 1].lat, history[i - 1].lon, history[i].lat, history[i].lon);
	}
	return d;
}

function netDisplacementM(history: FixRecord[]): number {
	if (history.length < 2) return 0;
	const first = history[0];
	const last = history[history.length - 1];
	return haversineMeters(first.lat, first.lon, last.lat, last.lon);
}

/** Effective speed across the whole history. Path distance / elapsed time. */
export function effectiveSpeedKmh(history: FixRecord[]): number {
	if (history.length < 2) return 0;
	const dt = history[history.length - 1].ts - history[0].ts;
	if (dt <= 0) return 0;
	return (pathDistanceM(history) / dt) * 3.6;
}

/** Net displacement / total path length, 0..1. */
export function straightnessRatio(history: FixRecord[]): number {
	if (history.length < 2) return 0;
	const path = pathDistanceM(history);
	if (path === 0) return 0;
	return netDisplacementM(history) / path;
}

function historySpansSec(history: FixRecord[]): number {
	if (history.length < 2) return 0;
	return history[history.length - 1].ts - history[0].ts;
}

/** Returns "walking" if history shows directional motion at walking pace,
 *  null otherwise. Caller prunes history to the desired window first. */
export function classifyFromHistory(history: FixRecord[]): MotionProfile {
	if (history.length < MIN_WALKING_FIXES) return null;
	const v = effectiveSpeedKmh(history);
	if (v < WALKING_MIN_KMH || v > WALKING_MAX_KMH) return null;
	if (straightnessRatio(history) < WALKING_MIN_STRAIGHTNESS) return null;
	return "walking";
}

// ============================================================================
// Signal extraction
// ============================================================================

/**
 * Reduce a fix history into the signals the decision pipeline consumes.
 * All numeric signals default to 0 when there's too little data to
 * compute them — predicates check `historySpanSec` to know whether a
 * given signal is meaningful.
 */
export function computeSignals(history: FixRecord[]): DecisionSignals {
	const empty: DecisionSignals = {
		reportedVelKmh: 0,
		computedVelKmh: 0,
		gapSinceLastFixSec: 0,
		effectiveSpeedKmh: 0,
		straightness: 0,
		historySpanSec: 0,
		trigger: null,
		monitoringMode: null,
	};
	if (history.length === 0) return empty;
	const last = history[history.length - 1];
	const reportedVelKmh = last.vel ?? 0;
	const trigger = last.trigger ?? null;
	const monitoringMode = last.monitoringMode ?? null;
	if (history.length === 1) {
		return { ...empty, reportedVelKmh, trigger, monitoringMode };
	}
	const prev = history[history.length - 2];
	const gap = last.ts - prev.ts;
	const distM = haversineMeters(prev.lat, prev.lon, last.lat, last.lon);
	const computedVelKmh = gap > 0 ? (distM / gap) * 3.6 : 0;
	return {
		reportedVelKmh,
		computedVelKmh,
		gapSinceLastFixSec: gap,
		effectiveSpeedKmh: effectiveSpeedKmh(history),
		straightness: straightnessRatio(history),
		historySpanSec: historySpansSec(history),
		trigger,
		monitoringMode,
	};
}

// ============================================================================
// Decision predicates
// ============================================================================

/** Is the phone reasonably understood to be in Significant ("energy
 *  saving") mode? Prefers the `m` field from the latest fix as ground
 *  truth — that's what the phone is actually doing right now. Falls back
 *  to "last profile we pushed" only when the phone hasn't told us. */
function isPhoneInSignificant(monitoringMode: number | null, prevProfile: MotionProfile): boolean {
	if (monitoringMode === 1) return true;
	if (monitoringMode === 2) return false;
	return prevProfile === "stationary" || prevProfile === null;
}

/**
 * Predicate 1: single-fix or computed velocity above the transit threshold
 * is enough to instantly escalate. Robust to a missing `vel` field
 * because computed velocity from displacement is also considered. Returns
 * null if neither speed source clears the threshold.
 */
export function escalateOnHighSpeed(signals: DecisionSignals): MotionProfile {
	const speed = Math.max(signals.reportedVelKmh, signals.computedVelKmh);
	if (speed > TRANSIT_FAST_KMH) return "transit-fast";
	if (speed > TRANSIT_KMH) return "transit";
	return null;
}

/**
 * Predicate 2: when the phone is in Significant mode, look for evidence
 * that it should be in Move. Three sources of evidence (any one is
 * enough): an Owntracks user-action trigger, a fix arriving much sooner
 * than the scheduled Significant cadence (the phone's motion sensor
 * fired), or visible displacement above walking pace. If history is rich
 * enough to refine, picks the precise profile; otherwise pushes a
 * conservative transit profile to get Move mode going.
 */
export function escalateFromSignificant(signals: DecisionSignals): MotionProfile {
	const speed = Math.max(signals.reportedVelKmh, signals.computedVelKmh);
	const motionEvidence =
		signals.trigger === "u" ||
		(signals.gapSinceLastFixSec > 0 && signals.gapSinceLastFixSec < SIGNIFICANT_MODE_MOTION_GAP_SEC) ||
		speed > WALKING_MIN_KMH;
	if (!motionEvidence) return null;

	if (signals.historySpanSec >= MIN_HISTORY_SPAN_FOR_REFINE_SEC) {
		if (signals.effectiveSpeedKmh > TRANSIT_FAST_KMH) return "transit-fast";
		if (signals.effectiveSpeedKmh > TRANSIT_KMH) return "transit";
		if (
			signals.effectiveSpeedKmh >= WALKING_MIN_KMH &&
			signals.effectiveSpeedKmh <= WALKING_MAX_KMH &&
			signals.straightness >= WALKING_MIN_STRAIGHTNESS
		) {
			return "walking";
		}
	}
	return "transit";
}

/**
 * Predicate 3: when the phone is in Move mode and we have enough history,
 * pick the precise profile from effective speed + straightness. Returns
 * null if history is too thin or no profile applies (mid-range
 * effective speed without a walking signature).
 */
export function refineInMove(signals: DecisionSignals): MotionProfile {
	if (signals.historySpanSec < MIN_HISTORY_SPAN_FOR_REFINE_SEC) return null;
	if (signals.effectiveSpeedKmh > TRANSIT_FAST_KMH) return "transit-fast";
	if (signals.effectiveSpeedKmh > TRANSIT_KMH) return "transit";
	if (
		signals.effectiveSpeedKmh >= WALKING_MIN_KMH &&
		signals.effectiveSpeedKmh <= WALKING_MAX_KMH &&
		signals.straightness >= WALKING_MIN_STRAIGHTNESS
	) {
		return "walking";
	}
	return null;
}

/**
 * Predicate 4: demote to Significant only after the full 10-minute window
 * shows sustained low-speed motion. Short low-speed runs (3 fixes at a
 * stop light, brief tunnel signal loss) get ignored.
 */
export function demoteAfterStop(signals: DecisionSignals): MotionProfile {
	if (signals.historySpanSec < MIN_STATIONARY_DEMOTE_SEC) return null;
	if (signals.effectiveSpeedKmh >= WALKING_MIN_KMH) return null;
	return "stationary";
}

// ============================================================================
// Top-level decision
// ============================================================================

/** "keep" means "no transition this fix" — caller preserves lastProfile. */
export type Transition = MotionProfile | "keep";

/**
 * Run the signals through the predicate cascade. Priority order:
 *
 *   1. High-speed escalation (single fix or computed) — wins everywhere
 *      because boarding a train shouldn't wait for history.
 *   2. Significant→Move escalation — only fires when the phone is
 *      currently in Significant (no point escalating from Move).
 *   3. Move-mode refinement — picks the precise profile based on
 *      history.
 *   4. Move→Significant demotion — only after sustained evidence of
 *      stopping.
 *
 * "keep" propagates back to the caller as "no patch, preserve last
 * profile."
 */
export function decideTransition(signals: DecisionSignals, prevProfile: MotionProfile): Transition {
	const fast = escalateOnHighSpeed(signals);
	if (fast !== null) return fast;

	if (isPhoneInSignificant(signals.monitoringMode, prevProfile)) {
		return escalateFromSignificant(signals) ?? "keep";
	}

	return refineInMove(signals) ?? demoteAfterStop(signals) ?? "keep";
}

// ============================================================================
// Profile → patch mapping
// ============================================================================

/** Owntracks settings per motion regime. */
const PROFILE_CONFIG: Record<Exclude<MotionProfile, null>, OwntracksConfigPatch> = {
	"transit-fast": { monitoring: 2, moveModeLocatorInterval: 10 },
	transit: { monitoring: 2, moveModeLocatorInterval: 15 },
	walking: { monitoring: 2, moveModeLocatorInterval: 30 },
	stationary: { monitoring: 1 },
};

// ============================================================================
// Public wrapper with anti-flap
// ============================================================================

export interface RemoteConfigOptions {
	/** Unix-seconds timestamp of the last patch we pushed for this device. */
	lastPushTs?: number | null;
	/** Unix-seconds timestamp of the current fix being decided on. */
	nowTs?: number;
}

/**
 * Top-level "should we push a config command" decision.
 *
 * Computes signals from the history, runs the predicate cascade, and
 * gates the resulting patch with an anti-flap window. The window
 * suppresses mode changes that would land within `ANTI_FLAP_WINDOW_SEC`
 * of the previous push — except for high-confidence single-fix
 * escalations (reported `vel` > 30 km/h), which always go through.
 *
 * `speedKmh` is the single-fix velocity convenience argument used when
 * the caller has no history yet; with history, `computeSignals` derives
 * the same value (and more) from the last fix.
 */
export function decideRemoteConfig(
	speedKmh: number,
	lastProfile: MotionProfile,
	history: FixRecord[] = [],
	options: RemoteConfigOptions = {},
): { profile: MotionProfile; patch: OwntracksConfigPatch | null } {
	const signals: DecisionSignals =
		history.length > 0
			? computeSignals(history)
			: {
					reportedVelKmh: speedKmh,
					computedVelKmh: 0,
					gapSinceLastFixSec: 0,
					effectiveSpeedKmh: 0,
					straightness: 0,
					historySpanSec: 0,
					trigger: null,
					monitoringMode: null,
				};

	const next = decideTransition(signals, lastProfile);
	if (next === "keep" || next === null) return { profile: lastProfile, patch: null };
	if (next === lastProfile) return { profile: next, patch: null };

	const isHighConfidence = signals.reportedVelKmh > TRANSIT_KMH;
	if (
		!isHighConfidence &&
		options.lastPushTs !== undefined &&
		options.lastPushTs !== null &&
		options.nowTs !== undefined &&
		options.nowTs - options.lastPushTs < ANTI_FLAP_WINDOW_SEC
	) {
		return { profile: lastProfile, patch: null };
	}

	return { profile: next, patch: PROFILE_CONFIG[next] };
}

// ============================================================================
// Route handler state
// ============================================================================

/** Maximum number of distinct (token,device) state keys we'll retain at
 *  once. Single-user setups only ever populate 1-3 keys, but a cap
 *  prevents unbounded growth if a misconfigured client cycles device
 *  names or tokens. Eviction is LRU-by-recency-of-write — a key gets
 *  re-promoted every time we touch it. */
const MAX_STATE_KEYS = 32;

/** Promote `key` to most-recently-used and evict the oldest entry from
 *  every state map in lockstep. JS Maps preserve insertion order, so
 *  delete-then-set moves the key to the end. */
function touchStateKey(key: string): void {
	if (historyByKey.has(key)) historyByKey.delete(key);
	if (lastProfileByKey.has(key)) lastProfileByKey.delete(key);
	if (lastPushTsByKey.has(key)) lastPushTsByKey.delete(key);
	// Caller re-inserts via .set after we've made room below.
	while (historyByKey.size >= MAX_STATE_KEYS) {
		const oldest = historyByKey.keys().next().value;
		if (oldest === undefined) break;
		historyByKey.delete(oldest);
		lastProfileByKey.delete(oldest);
		lastPushTsByKey.delete(oldest);
	}
}

/** Per (token,device) memory of the last-pushed motion profile. */
const lastProfileByKey = new Map<string, MotionProfile>();
/** Per-device fix history used by the decision pipeline. */
const historyByKey = new Map<string, FixRecord[]>();
/** Per-device timestamp of the last config push, for anti-flap. */
const lastPushTsByKey = new Map<string, number>();

// ============================================================================
// Route
// ============================================================================

export function owntracksRoutes(config: Config): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const allowedTokens = new Set(config.owntracks.allowedTokens);

	app.post(
		"/:token/:device",
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: (c) => c.json({ error: "payload too large" }, 413),
		}),
		async (c) => {
			const token = c.req.param("token");
			const device = c.req.param("device");

			// Auth gate: require HTTP Basic Auth header presence (Owntracks
			// Android always sends it) and validate the URL token against the
			// configured allowlist. Both guard the in-process state maps and
			// avoid pointless upstream round-trips on adversarial probes.
			if (!c.req.header("Authorization")) {
				return c.json({ error: "authorization required" }, 401);
			}
			if (!allowedTokens.has(token)) {
				return c.json({ error: "token not permitted" }, 403);
			}

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
			// along with the body. User-Agent is forwarded so PhoneTrack-side
			// logs/rate-limiting attribute correctly to the real client.
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

			if (upstreamRes === null) return c.json({ error: "upstream unreachable" }, 502);
			if (!upstreamRes.ok) return c.json({ error: "upstream rejected" }, upstreamRes.status as 400 | 502);

			// Build fix records from the payload. We retain only `location`
			// messages with full position; pings without coordinates contribute
			// to nothing useful for our decision.
			const messages = Array.isArray(payload) ? payload : [payload];
			const stateKey = `${token}/${device}`;
			const newFixes: FixRecord[] = [];
			for (const msg of messages) {
				if (msg.lat !== undefined && msg.lon !== undefined && msg.tst !== undefined) {
					newFixes.push({
						ts: msg.tst,
						lat: msg.lat,
						lon: msg.lon,
						vel: msg.vel ?? null,
						trigger: msg.t ?? null,
						monitoringMode: msg.m ?? null,
					});
				}
			}
			const nowTs = newFixes.length > 0 ? newFixes[newFixes.length - 1].ts : Math.floor(Date.now() / 1000);

			const merged = [...(historyByKey.get(stateKey) ?? []), ...newFixes];
			const history = pruneFixHistory(merged, HISTORY_MAX_AGE_SEC, nowTs);
			// LRU bookkeeping: promotes stateKey to most-recent and evicts the
			// oldest entries from every state map if we're above the cap.
			touchStateKey(stateKey);
			historyByKey.set(stateKey, history);

			const prevProfile = lastProfileByKey.get(stateKey) ?? null;
			const lastPushTs = lastPushTsByKey.get(stateKey) ?? null;

			const signals: DecisionSignals =
				history.length > 0
					? computeSignals(history)
					: {
							reportedVelKmh: 0,
							computedVelKmh: 0,
							gapSinceLastFixSec: 0,
							effectiveSpeedKmh: 0,
							straightness: 0,
							historySpanSec: 0,
							trigger: null,
							monitoringMode: null,
						};

			const maxVel = signals.reportedVelKmh;
			const { profile, patch } = decideRemoteConfig(maxVel, prevProfile, history, { lastPushTs, nowTs });

			// One-line decision log per Owntracks POST — makes proxy behaviour
			// debuggable from `kubectl logs` without instrumenting the phone.
			// Fields: vel = reported velocity, cvel = computed velocity from
			// displacement, hist = fix count, eff = history-effective speed,
			// str = straightness, gap = seconds since previous fix, t = Owntracks
			// trigger type, m = monitoring mode reported by phone, prev->next =
			// profile transition, patch = the config command (or "no-op").
			const patchStr = patch ? JSON.stringify(patch) : "no-op";
			console.log(
				`owntracks ${token.slice(0, 6)}/${device} vel=${signals.reportedVelKmh.toFixed(1)} cvel=${signals.computedVelKmh.toFixed(1)} hist=${history.length} eff=${signals.effectiveSpeedKmh.toFixed(1)}km/h str=${signals.straightness.toFixed(2)} gap=${signals.gapSinceLastFixSec}s t=${signals.trigger ?? "-"} m=${signals.monitoringMode ?? "-"} ${prevProfile ?? "init"}->${profile ?? "keep"} ${patchStr}`,
			);

			if (patch !== null) {
				lastProfileByKey.set(stateKey, profile);
				lastPushTsByKey.set(stateKey, nowTs);
			}

			// Preserve PhoneTrack's response body (the "you are your own
			// friend" location-echo Owntracks needs to render the user's marker
			// on its in-app map). Append our cmd to that array.
			let baseResponse: unknown[] = [];
			try {
				const upstreamBody = await upstreamRes.text();
				if (upstreamBody.trim().length > 0) {
					const parsed = JSON.parse(upstreamBody);
					if (Array.isArray(parsed)) baseResponse = parsed;
				}
			} catch {
				// Upstream returned non-JSON; nothing to pass through.
			}

			if (patch !== null) {
				baseResponse.push({
					_type: "cmd",
					action: "setConfiguration",
					configuration: { _type: "configuration", ...patch },
				} satisfies OwntracksCommand);
			}
			return c.json(baseResponse);
		},
	);

	return app;
}
