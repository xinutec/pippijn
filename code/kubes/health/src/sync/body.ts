import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";

interface WeightResponse {
  weight: Array<{
    date: string;
    weight: number;
    bmi: number;
    fat?: number;
  }>;
}

interface BodyTimeSeriesResponse {
  "body-weight": Array<{ dateTime: string; value: string }>;
  "body-bmi": Array<{ dateTime: string; value: string }>;
  "body-fat": Array<{ dateTime: string; value: string }>;
}

export async function syncBody(
  client: FitbitClient,
  db: mariadb.Connection,
  startDate: string,
  endDate: string
): Promise<number> {
  // Use weight log endpoint for date range
  const data = await client.get<WeightResponse>(
    `/1/user/-/body/log/weight/date/${startDate}/${endDate}.json`
  );

  let synced = 0;

  for (const entry of data.weight) {
    await db.query(
      `INSERT INTO body (date, weight_kg, bmi, body_fat_pct)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         weight_kg = VALUES(weight_kg),
         bmi = VALUES(bmi),
         body_fat_pct = VALUES(body_fat_pct)`,
      [entry.date, entry.weight, entry.bmi, entry.fat ?? null]
    );
    synced++;
  }

  console.log(`Synced ${synced} body measurements`);
  return synced;
}
