/**
 * PhoneTrack visualisation-filter helpers.
 *
 * PhoneTrack persists per-user UI prefs in oc_preferences (via Nextcloud's
 * setUserValue / getUserValue). The visualisation date filter is one of these:
 * `datemin`, `datemax`, `timestampmin`, plus hour/minute/second granularity.
 *
 * We use this to set a sensible default range each time the dashboard loads:
 * "all of yesterday up to now until 06:00 local, then today from 00:00 local"
 * (no end-date filter). The user can browse history on PhoneTrack itself
 * without us interfering — we only re-set on dashboard load.
 */

import { dateBoundsUtc } from "../geo/timezone.js";

const DEFAULT_NIGHT_CUTOFF_HOUR = 6;

/**
 * Returns unix UTC seconds for the start of:
 *   - today 00:00 local time, if `now` is at/after `cutoffHour` local
 *   - yesterday 00:00 local time, if `now` is before `cutoffHour` local
 *
 * The output is what PhoneTrack expects in its `datemin` / `timestampmin`
 * preference values.
 */
export function computePhoneTrackDatemin(now: Date, tz: string, cutoffHour = DEFAULT_NIGHT_CUTOFF_HOUR): number {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(now);
	const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? "";
	let y = Number(get("year"));
	let mo = Number(get("month"));
	let d = Number(get("day"));
	let hour = Number(get("hour"));
	if (hour === 24) hour = 0;

	if (hour < cutoffHour) {
		// Roll back one day in the local calendar
		const prev = new Date(Date.UTC(y, mo - 1, d) - 86400_000);
		y = prev.getUTCFullYear();
		mo = prev.getUTCMonth() + 1;
		d = prev.getUTCDate();
	}

	const dateStr = `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
	return dateBoundsUtc(dateStr, tz).startUtc;
}

/**
 * The full set of PhoneTrack option key/values we want to set when applying
 * our default visualisation filter. `applyfilters: true` is required for
 * PhoneTrack to honour the date range; the time-of-day fields are cleared
 * so they don't further restrict the view.
 */
export function buildPhoneTrackFilterValues(datemin: number): Record<string, string> {
	return {
		applyfilters: "1",
		datemin: String(datemin),
		timestampmin: String(datemin),
		datemax: "",
		hourmin: "",
		hourmax: "",
		minutemin: "",
		minutemax: "",
		secondmin: "",
		secondmax: "",
	};
}
