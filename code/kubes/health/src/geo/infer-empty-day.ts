import { db } from "../db/pool.js";
import type { DayState } from "../sleep/day-state.js";
import { bracketedStayPlaceId, buildInferredStayState } from "./inferred-stay.js";
import { bestPlace, placeLabel } from "./osm.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { dateBoundsUtc } from "./timezone.js";

function shiftDay(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * Infer the "your day" for a day with no observed data.
 *
 * A no-data day is not automatically *unknown*: if the previous day
 * ended at place X and the next day's dominant place is also X, the user
 * was at X the whole time in between (the classic multi-day hospital
 * stay). Confidence comes from the day being fully *constrained* on both
 * sides, not from data volume — so this surfaces one stationary stay
 * spanning the local day, named from the focus_place's centroid via OSM,
 * and flagged `inferred: true` so the UI marks it "no data".
 *
 * Returns `[]` when the day isn't bracketed by the same place (then it is
 * genuinely unknown and stays blank) or the place can't be resolved.
 */
export async function inferEmptyDayStates(
	userId: string,
	date: string,
	tz: string | undefined,
	osm: OsmAdapter,
): Promise<DayState[]> {
	const [prev, next] = await Promise.all([
		db()
			.selectFrom("presence_log")
			.where("user_id", "=", userId)
			.where("date", "=", shiftDay(date, -1))
			.select(["end_of_day_place_id"])
			.executeTakeFirst(),
		db()
			.selectFrom("presence_log")
			.where("user_id", "=", userId)
			.where("date", "=", shiftDay(date, +1))
			.select(["dominant_place_id"])
			.executeTakeFirst(),
	]);

	const placeId = bracketedStayPlaceId(prev?.end_of_day_place_id ?? null, next?.dominant_place_id ?? null);
	if (placeId === null) return [];

	const fp = await db()
		.selectFrom("focus_places")
		.where("id", "=", placeId)
		.select(["centroid_lat", "centroid_lon"])
		.executeTakeFirst();
	if (fp === undefined) return [];

	const place = await bestPlace(osm, Number(fp.centroid_lat), Number(fp.centroid_lon), { preferResidential: false });
	if (place === null) return [];

	const bounds = dateBoundsUtc(date, tz);
	return [
		buildInferredStayState({
			place: placeLabel(place),
			tz: tz ?? null,
			startTs: bounds.startUtc,
			endTs: bounds.endUtc,
		}),
	];
}
