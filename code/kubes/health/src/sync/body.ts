import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";

interface WeightResponse {
  weight: Array<{ date: string; weight: number; bmi: number; fat?: number }>;
}

export async function syncBody(
  client: FitbitClient, db: mariadb.Connection,
  userId: string, startDate: string, endDate: string
): Promise<number> {
  const data = await client.get<WeightResponse>(
    `/1/user/-/body/log/weight/date/${startDate}/${endDate}.json`
  );
  let synced = 0;

  for (const entry of data.weight) {
    await db.query(
      `INSERT INTO body (user_id, date, weight_kg, bmi, body_fat_pct)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg), bmi = VALUES(bmi), body_fat_pct = VALUES(body_fat_pct)`,
      [userId, entry.date, entry.weight, entry.bmi, entry.fat ?? null]
    );
    synced++;
  }

  console.log(`[${userId}] Synced ${synced} body measurements`);
  return synced;
}
