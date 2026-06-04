/**
 * Production loader for `ClassificationInputs`.
 *
 * Phase 1 of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Mirrors the eager-fetch path currently inlined at the top of
 * `computeVelocity`. Production wraps the classification pipeline by
 * calling `loadClassificationInputs` then `computeVelocity(inputs)`
 * (Phase 2 — refactor not yet applied). Tests load from a captured
 * fixture instead.
 *
 * Phase 1 covers only the eager loads. The lazy ones (OSM mirror,
 * decoded_days, rail_route_cache, presence_log) keep being fetched
 * from the DB inside the pipeline until their own phase migrates
 * them onto the inputs value. The `ClassificationInputs` type
 * evolves additively.
 *
 * No behaviour change: this file's queries are byte-for-byte the
 * same projections used inside `velocity.ts` today. Verified during
 * Phase 2 by running the existing golden suite — zero diff is the
 * acceptance criterion.
 */

import { db } from "../db/pool.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../nextcloud/phonetrack.js";
import type {
	ClassificationInputs,
	DayIdentity,
	KnownPlaceProjection,
	RawPhonetrackFix,
} from "./classification-inputs.js";
import { parseHourProfile } from "./focus-places.js";
import type { ModeStats } from "./mode-biometrics.js";
import { dateBoundsUtc } from "./timezone.js";
import { loadBiometrics } from "./velocity.js";

/** Load the full `ClassificationInputs` closure for one day from the
 *  production data sources. The Promise resolves to a serialisable
 *  value the pipeline can consume; nothing in the value holds a DB
 *  handle. */
export async function loadClassificationInputs(
	config: { nextcloud: NextcloudConfig },
	identity: DayIdentity,
): Promise<ClassificationInputs> {
	const { userId, date, displayTz } = identity;
	const bounds = dateBoundsUtc(date, displayTz);

	// Same day-string arithmetic as velocity.ts — UTC-midnight parse,
	// ±1 day, ISO date slice. Keeps the three PhoneTrack window
	// boundaries identical to the inlined version.
	const nextDay = shiftDay(date, +1);
	const prevDay = shiftDay(date, -1);
	const nextDayMorningEnd = `${nextDay}T12:00:00Z`;
	const prevDayEveningStart = `${prevDay}T12:00:00Z`;

	// PhoneTrack: open once, three parallel range fetches. Mirrors the
	// pattern at velocity.ts:537-544 — three windows off one session
	// context, same call shape.
	const phoneTrackCtx = await openPhoneTrack(config.nextcloud, userId);
	const [today, morning, priorEvening] = await Promise.all([
		fetchTrackPointsRange(phoneTrackCtx, date, nextDay),
		fetchTrackPointsRange(phoneTrackCtx, nextDay, nextDayMorningEnd),
		fetchTrackPointsRange(phoneTrackCtx, prevDayEveningStart, date),
	]);

	// Eager DB reads in parallel — known places, mode biometrics, and
	// the per-day biometric streams. The biometric loader does its own
	// three parallel queries (HR / sleep / steps), so we await the
	// composite. Failure on biometrics is non-fatal in prod
	// (computeVelocity catches and returns empty arrays); we let it
	// throw here and the caller decides. The pipeline's tolerance is a
	// concern of the wrapper, not the loader.
	const [knownPlaces, modeBiometrics, biometrics] = await Promise.all([
		loadKnownPlacesQuery(userId),
		loadModeBiometricsQuery(userId),
		loadBiometrics(userId, bounds.startUtc, bounds.endUtc, displayTz),
	]);

	return {
		identity,
		phonetrack: {
			today: today as RawPhonetrackFix[],
			morning: morning as RawPhonetrackFix[],
			priorEvening: priorEvening as RawPhonetrackFix[],
		},
		knownPlaces,
		biometrics,
		modeBiometrics,
	};
}

function shiftDay(date: string, days: number): string {
	const d = new Date(date);
	d.setDate(d.getDate() + days);
	return d.toISOString().slice(0, 10);
}

/** focus_places projection used by `snapToPlace` + the place picker.
 *  Same SELECT columns and same row mapping as `loadKnownPlaces`
 *  inside `velocity.ts`. Phase 2 will collapse the duplication by
 *  removing the inline copy. */
async function loadKnownPlacesQuery(userId: string): Promise<KnownPlaceProjection[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.select([
			"id",
			"centroid_lat",
			"centroid_lon",
			"radius_m",
			"display_name",
			"sleep_hours",
			"amenity_label",
			"unique_days",
			"hour_profile",
		])
		.where("user_id", "=", userId)
		.execute();
	return rows.map((r) => ({
		id: r.id,
		centroidLat: Number(r.centroid_lat),
		centroidLon: Number(r.centroid_lon),
		radiusM: r.radius_m,
		displayName: r.display_name,
		sleepHours: r.sleep_hours ?? 0,
		amenityLabel: r.amenity_label,
		uniqueDays: r.unique_days,
		hourProfile: parseHourProfile(r.hour_profile),
	}));
}

/** mode_biometrics projection — per-user per-mode biometric
 *  signatures. Same SELECT and row mapping as `loadModeBiometrics`
 *  inside `velocity.ts`. */
async function loadModeBiometricsQuery(userId: string): Promise<ModeStats[]> {
	const rows = await db().selectFrom("mode_biometrics").selectAll().where("user_id", "=", userId).execute();
	return rows.map((r) => ({
		mode: r.mode,
		hrMean: r.hr_mean !== null ? Number(r.hr_mean) : null,
		hrStd: r.hr_std !== null ? Number(r.hr_std) : null,
		hrSampleCount: r.hr_sample_count,
		cadenceMean: r.cadence_mean !== null ? Number(r.cadence_mean) : null,
		cadenceStd: r.cadence_std !== null ? Number(r.cadence_std) : null,
		cadenceSampleCount: r.cadence_sample_count,
		speedMean: r.speed_mean !== null ? Number(r.speed_mean) : null,
		speedStd: r.speed_std !== null ? Number(r.speed_std) : null,
		speedSampleCount: r.speed_sample_count,
		sampleCount: r.sample_count,
	}));
}
