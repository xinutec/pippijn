import { describe, expect, it } from "vitest";
import { parseGroundTruth } from "../../src/eval/ground-truth.js";

/**
 * Parser tests cover the format variants seen across the five real
 * ground-truth files (column counts 3 or 4; em-dash window separator;
 * bolded `**wrong**` status; trailing notes column with free text;
 * `train BoardingStation → AlightingStation · Line Name` blessed-cell
 * shape). Fixtures are synthetic — the real files are gitignored
 * because they carry private context.
 */

const MINIMAL_FOUR_COL = `# 2026-05-22 — ground truth

## Audit of 2026-05-22 blessed golden

| Window         | Blessed                                                     | Status     | Correct version                                             |
| -------------- | ----------------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| 00:05 – 08:58  | sleeping @ Home                                             | correct    |                                                             |
| 09:08 – 13:02  | stationary @ Home                                           | correct    |                                                             |
| 13:02 – 13:16  | walking                                                     | correct    | walking to Wembley Park tube                                |
| 13:16 – 13:26  | train Wembley Park → Baker Street                           | partial    | Should be labelled "Metropolitan Line"                      |
| 13:26 – 13:35  | train Baker Street → Green Park · Jubilee Line              | correct    | Two-leg shape was right                                     |
| 19:55 – 20:04  | walking on Pentonville Road                                 | correct    |                                                             |
| 20:05 – 20:12  | driving on Euston Underpass                                 | **wrong**  | This is the Met Line tube to Finchley Road, not driving     |
| 20:46 – 23:59  | stationary @ Royal Free Hospital                            | correct    |                                                             |
`;

const MINIMAL_THREE_COL_WITH_TRAILING_NOTES = `# 2026-04-29 — ground truth

## Audit of 2026-04-29 blessed golden (post Layer 1 re-bless)

| Window         | Blessed (now)                                       | Status   |
| -------------- | --------------------------------------------------- | -------- |
| 22:16 – 08:08  | sleeping @ Parkhotel Den Haag (hotel)               | correct  | Was "@ Molenstraat 61A" pre-Layer 1.
| 09:51 – 10:50  | stationary @ Parkhotel Den Haag (hotel)             | correct  |
| 11:05 – 11:10  | stationary on HMC Westeinde Heliport                | partial  | A heliport label for a walking-past moment.
| 18:48 – 22:13  | walking                                             | wrong    | Sparse-day phantom motion.
`;

describe("parseGroundTruth", () => {
	it("returns empty rows for content with no audit table", () => {
		const out = parseGroundTruth("# Just a narrative, no table\n\nSome text.", "2026-05-22", "Europe/London");
		expect(out.date).toBe("2026-05-22");
		expect(out.tz).toBe("Europe/London");
		expect(out.rows).toEqual([]);
	});

	it("parses a 4-column table including correct-version cells", () => {
		const out = parseGroundTruth(MINIMAL_FOUR_COL, "2026-05-22", "Europe/London");
		expect(out.rows.length).toBe(8);
		const r0 = out.rows[0];
		expect(r0.windowText).toBe("00:05 – 08:58");
		expect(r0.status).toBe("correct");
		expect(r0.blessed?.mode).toBe("sleeping");
		expect(r0.blessed?.place).toBe("Home");
		expect(r0.correctVersionText).toBeNull(); // empty cell → null
	});

	it("normalises **wrong** to wrong", () => {
		const out = parseGroundTruth(MINIMAL_FOUR_COL, "2026-05-22", "Europe/London");
		const wrongRow = out.rows.find((r) => r.blessedText.includes("Euston Underpass"));
		expect(wrongRow?.status).toBe("wrong");
		expect(wrongRow?.correctVersionText).toContain("Met Line");
	});

	it("parses a 3-column table with trailing notes after status", () => {
		const out = parseGroundTruth(MINIMAL_THREE_COL_WITH_TRAILING_NOTES, "2026-04-29", "Europe/Amsterdam");
		expect(out.rows.length).toBe(4);
		const noteRow = out.rows.find((r) => r.windowText === "11:05 – 11:10");
		expect(noteRow?.status).toBe("partial");
		expect(noteRow?.correctVersionText).toContain("heliport");
	});

	it("parses cross-midnight windows as ending the next day", () => {
		const out = parseGroundTruth(MINIMAL_THREE_COL_WITH_TRAILING_NOTES, "2026-04-29", "Europe/Amsterdam");
		const sleepRow = out.rows.find((r) => r.windowText === "22:16 – 08:08");
		if (sleepRow === undefined) throw new Error("sleep row missing");
		// 22:16 on 2026-04-29 → 08:08 on 2026-04-30 in Europe/Amsterdam.
		// We expect end > start by ~9h52m = 35520s.
		expect(sleepRow.endTs - sleepRow.startTs).toBe(9 * 3600 + 52 * 60);
	});

	it("classifies blessed cells: sleeping / stationary @ Place / walking / driving / train", () => {
		const out = parseGroundTruth(MINIMAL_FOUR_COL, "2026-05-22", "Europe/London");
		const byWindow = new Map(out.rows.map((r) => [r.windowText, r.blessed]));

		expect(byWindow.get("00:05 – 08:58")?.mode).toBe("sleeping");
		expect(byWindow.get("00:05 – 08:58")?.place).toBe("Home");

		expect(byWindow.get("09:08 – 13:02")?.mode).toBe("stationary");
		expect(byWindow.get("09:08 – 13:02")?.place).toBe("Home");

		expect(byWindow.get("13:02 – 13:16")?.mode).toBe("walking");
		expect(byWindow.get("13:02 – 13:16")?.place).toBeNull();

		expect(byWindow.get("20:05 – 20:12")?.mode).toBe("driving");
		expect(byWindow.get("20:05 – 20:12")?.wayName).toBe("Euston Underpass");

		const trainNoLine = byWindow.get("13:16 – 13:26");
		expect(trainNoLine?.mode).toBe("train");
		expect(trainNoLine?.trainFromTo).toEqual({ from: "Wembley Park", to: "Baker Street" });
		expect(trainNoLine?.lineName).toBeNull();

		const trainWithLine = byWindow.get("13:26 – 13:35");
		expect(trainWithLine?.mode).toBe("train");
		expect(trainWithLine?.trainFromTo).toEqual({ from: "Baker Street", to: "Green Park" });
		expect(trainWithLine?.lineName).toBe("Jubilee Line");
	});

	it("strips trailing parenthetical type qualifiers from place names", () => {
		const out = parseGroundTruth(MINIMAL_THREE_COL_WITH_TRAILING_NOTES, "2026-04-29", "Europe/Amsterdam");
		const hotelRow = out.rows.find((r) => r.windowText === "22:16 – 08:08");
		// "Parkhotel Den Haag (hotel)" → place "Parkhotel Den Haag", placeQualifier "hotel"
		expect(hotelRow?.blessed?.place).toBe("Parkhotel Den Haag");
		expect(hotelRow?.blessed?.placeQualifier).toBe("hotel");
	});

	it("returns groundTruthAt(minute) resolving any minute in the day", () => {
		const out = parseGroundTruth(MINIMAL_FOUR_COL, "2026-05-22", "Europe/London");
		// 00:30 local on 2026-05-22 → covered by 00:05 – 08:58 sleeping row.
		// Compute the UTC ts for 00:30 London on 2026-05-22.
		const ts = Date.UTC(2026, 4, 21, 23, 30, 0) / 1000; // 00:30 BST = 23:30 UTC prev day
		const row = out.rows.find((r) => r.startTs <= ts && ts < r.endTs);
		expect(row?.blessed?.mode).toBe("sleeping");
	});
});
