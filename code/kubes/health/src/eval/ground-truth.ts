/**
 * Parser for `tests/golden/ground-truth/YYYY-MM-DD.md` audit tables.
 *
 * Each ground-truth file has a free-text narrative followed by an
 * `## Audit of ...` section containing a markdown table. The table is
 * the structured truth signal: per-window status (`correct` / `wrong`
 * / `partial` / `unclear`) plus, when blessed-cell content matches
 * what actually happened, the cell content IS the ground-truth state.
 *
 * Why a parser exists at all:
 *
 *   The HMM and pipeline have been measured against either each other
 *   (`compare-hmm-vs-heuristic`) or against previously-blessed pipeline
 *   output (`npm run golden`) — both self-referential. The narratives
 *   are the actual truth signal, but were a manual-only reference
 *   until this module. Programmatic comparison vs ground truth is the
 *   precondition for honest evaluation of any classification change.
 *
 * Pure module. No DB, no IO, no globals.
 */

import { fitbitTsToUnix } from "../geo/timezone.js";

export type AuditStatus = "correct" | "wrong" | "partial" | "unclear";

export type GroundTruthMode = "sleeping" | "stationary" | "walking" | "cycling" | "driving" | "train" | "plane";

export interface ParsedBlessed {
	mode: GroundTruthMode;
	/** Focus-place name (e.g. "Home", "Cleveland Clinic London"). `null`
	 *  for movement modes or train. */
	place: string | null;
	/** OSM way name when the blessed cell is "walking on X" or
	 *  "driving on X". Distinct from `place` — a way attribution is
	 *  weaker signal (it's just the nearest road, not a destination). */
	wayName: string | null;
	/** Trailing parenthetical qualifier — e.g. "(hotel)" on
	 *  "Parkhotel Den Haag (hotel)" surfaces the amenity classification
	 *  the pipeline emitted. Useful diagnostic when place names match
	 *  but the qualifier reveals a wrong-amenity attribution. */
	placeQualifier: string | null;
	/** Train boarding + alighting station names. `null` for non-train
	 *  modes. */
	trainFromTo: { from: string; to: string } | null;
	/** Named rail line (e.g. "Metropolitan Line"). `null` when the
	 *  blessed cell omits the `· Line Name` suffix (which itself is a
	 *  partial-attribution signal). */
	lineName: string | null;
}

export interface GroundTruthRow {
	/** Original window text from the table — e.g. "13:02 – 13:16". */
	windowText: string;
	/** UTC unix seconds of the window's start. */
	startTs: number;
	/** UTC unix seconds of the window's end (exclusive). When the end
	 *  hour:minute is less than the start, the window crosses midnight
	 *  and `endTs` is the next calendar day. */
	endTs: number;
	/** Original blessed-cell text, verbatim — kept so diagnostics can
	 *  show the human-readable reference even when `blessed` failed to
	 *  parse into structured form. */
	blessedText: string;
	/** Structured form of the blessed cell. `null` when the cell didn't
	 *  match any known shape (e.g. an "unlabelled sliver" or some other
	 *  edge case in the narrative). */
	blessed: ParsedBlessed | null;
	status: AuditStatus;
	/** Raw status cell, useful for diagnostics. */
	statusText: string;
	/** "Correct version" or trailing-notes cell content — free-text the
	 *  human wrote describing what should have been emitted. `null` if
	 *  the cell is empty or absent. NOT parsed structurally — captured
	 *  for diagnostic display only. */
	correctVersionText: string | null;
}

export interface GroundTruthDay {
	/** Local date "YYYY-MM-DD" the file describes. */
	date: string;
	/** Timezone in which the table's HH:MM times are interpreted. */
	tz: string;
	rows: GroundTruthRow[];
}

const AUDIT_HEADING = /^##\s+Audit\s+of\s+/i;
const HEADING = /^##\s+/;
const TABLE_ROW = /^\s*\|/;

/** Parse a single ground-truth markdown file into structured form. */
export function parseGroundTruth(markdown: string, date: string, tz: string): GroundTruthDay {
	const lines = markdown.split("\n");
	const rows: GroundTruthRow[] = [];

	// Find the `## Audit of ...` section. Take rows until the next `##`.
	let inAudit = false;
	for (const line of lines) {
		if (AUDIT_HEADING.test(line)) {
			inAudit = true;
			continue;
		}
		if (inAudit && HEADING.test(line)) break;
		if (!inAudit) continue;
		if (!TABLE_ROW.test(line)) continue;

		const cells = splitTableRow(line);
		if (cells.length < 3) continue;
		// Skip header + separator rows.
		if (isHeaderRow(cells)) continue;
		if (isSeparatorRow(cells)) continue;

		const windowText = cells[0].trim();
		const blessedText = cells[1].trim();
		const statusText = cells[2].trim();
		const correctVersion = cells.length >= 4 ? cells.slice(3).join("|").trim() : "";

		const window = parseWindow(windowText, date, tz);
		if (window === null) continue;

		rows.push({
			windowText,
			startTs: window.startTs,
			endTs: window.endTs,
			blessedText,
			blessed: parseBlessedCell(blessedText),
			status: normaliseStatus(statusText),
			statusText,
			correctVersionText: correctVersion.length === 0 ? null : correctVersion,
		});
	}

	return { date, tz, rows };
}

/** Split a markdown table row on `|`, dropping the leading/trailing
 *  empty cells that result from `| ... |` formatting. */
function splitTableRow(line: string): string[] {
	const parts = line.split("|");
	// Drop one leading empty (from leading `|`).
	if (parts.length > 0 && parts[0].trim() === "") parts.shift();
	// Drop one trailing empty (from trailing `|`), but ONLY when the
	// original line ends with `|` — otherwise the last cell is real
	// (free-text notes that overflowed past a closing pipe).
	if (line.trimEnd().endsWith("|") && parts.length > 0 && parts[parts.length - 1].trim() === "") {
		parts.pop();
	}
	return parts;
}

function isHeaderRow(cells: readonly string[]): boolean {
	return cells[0].toLowerCase().includes("window");
}

function isSeparatorRow(cells: readonly string[]): boolean {
	return cells.every((c) => /^[\s:-]+$/.test(c));
}

/** Parse "HH:MM – HH:MM" into UTC unix seconds in `tz`. Returns null
 *  when the text doesn't match. End < start → window crosses midnight,
 *  end is the next calendar day. */
function parseWindow(text: string, date: string, tz: string): { startTs: number; endTs: number } | null {
	const m = /^(\d{2}):(\d{2})\s*[–-]\s*(\d{2}):(\d{2})$/.exec(text);
	if (!m) return null;
	const [, sh, sm, eh, em] = m;
	const startTs = fitbitTsToUnix(`${date} ${sh}:${sm}:00`, tz);
	let endTs = fitbitTsToUnix(`${date} ${eh}:${em}:00`, tz);
	if (endTs <= startTs) {
		const next = nextDay(date);
		endTs = fitbitTsToUnix(`${next} ${eh}:${em}:00`, tz);
	}
	if (Number.isNaN(startTs) || Number.isNaN(endTs)) return null;
	return { startTs, endTs };
}

function nextDay(date: string): string {
	const [y, mo, d] = date.split("-").map(Number);
	const dt = new Date(Date.UTC(y, mo - 1, d));
	dt.setUTCDate(dt.getUTCDate() + 1);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Map free-text status to one of four canonical values. Bold markers
 *  (`**wrong**`), trailing whitespace, and synonyms like "likely
 *  correct" are normalised here. */
function normaliseStatus(text: string): AuditStatus {
	const t = text.replace(/\*+/g, "").trim().toLowerCase();
	if (t === "wrong") return "wrong";
	if (t === "correct") return "correct";
	if (t === "partial") return "partial";
	// Anything qualified ("likely correct", "likely walking", "unclear",
	// empty) is treated as unclear — we can't score against it.
	return "unclear";
}

/** Parse a blessed-cell into structured form. Returns null when the
 *  text doesn't match any known shape. */
export function parseBlessedCell(text: string): ParsedBlessed | null {
	const t = text.trim();
	if (t.length === 0) return null;

	const verb = /^(sleeping|stationary|walking|cycling|driving|train|plane)\b\s*(.*)$/.exec(t);
	if (!verb) return null;
	const mode = verb[1] as GroundTruthMode;
	const rest = verb[2].trim();

	if (mode === "train") {
		// "train From → To" or "train From → To · Line"
		const tm = /^(.+?)\s+→\s+([^·]+?)(?:\s*·\s*(.+))?$/.exec(rest);
		if (tm) {
			return {
				mode,
				place: null,
				wayName: null,
				placeQualifier: null,
				trainFromTo: { from: tm[1].trim(), to: tm[2].trim() },
				lineName: tm[3]?.trim() ?? null,
			};
		}
		return {
			mode,
			place: null,
			wayName: null,
			placeQualifier: null,
			trainFromTo: null,
			lineName: null,
		};
	}

	// "@ Place [(qualifier)]" → focus-place attribution.
	const placeMatch = /^@\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(rest);
	if (placeMatch) {
		return {
			mode,
			place: placeMatch[1].trim(),
			wayName: null,
			placeQualifier: placeMatch[2]?.trim() ?? null,
			trainFromTo: null,
			lineName: null,
		};
	}

	// "on Way [(qualifier)]" → OSM-way attribution (weaker signal).
	const wayMatch = /^on\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(rest);
	if (wayMatch) {
		return {
			mode,
			place: null,
			wayName: wayMatch[1].trim(),
			placeQualifier: wayMatch[2]?.trim() ?? null,
			trainFromTo: null,
			lineName: null,
		};
	}

	// "(qualifier)" only (e.g. "stationary (unlabelled sliver)") —
	// the sliver case from the narrative; surface the qualifier but
	// leave place/way null.
	const qualOnly = /^\(([^)]+)\)$/.exec(rest);
	if (qualOnly) {
		return {
			mode,
			place: null,
			wayName: null,
			placeQualifier: qualOnly[1].trim(),
			trainFromTo: null,
			lineName: null,
		};
	}

	// Plain mode with no annotation (e.g. "walking", "driving").
	return {
		mode,
		place: null,
		wayName: null,
		placeQualifier: null,
		trainFromTo: null,
		lineName: null,
	};
}
