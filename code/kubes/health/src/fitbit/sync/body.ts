import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

export async function syncBody(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	const { weight } = await client.get<{
		weight: Array<{ date: string; weight: number; bmi: number; fat?: number }>;
	}>(`/1/user/-/body/log/weight/date/${startDate}/${endDate}.json`);

	for (const e of weight) {
		await conn.query(
			`INSERT INTO body (user_id, date, weight_kg, bmi, body_fat_pct) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE weight_kg=VALUES(weight_kg), bmi=VALUES(bmi), body_fat_pct=VALUES(body_fat_pct)`,
			[userId, e.date, e.weight, e.bmi, e.fat ?? null],
		);
	}

	console.log(`[${userId}] Synced ${weight.length} body entries`);
	return weight.length;
}
