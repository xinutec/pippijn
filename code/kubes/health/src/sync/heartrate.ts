import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";

interface HeartRateResponse {
  "activities-heart": Array<{
    dateTime: string;
    value: {
      restingHeartRate?: number;
      heartRateZones: Array<{
        name: string; min: number; max: number; minutes: number; caloriesOut: number;
      }>;
    };
  }>;
  "activities-heart-intraday"?: {
    dataset: Array<{ time: string; value: number }>;
  };
}

export async function syncHeartRateZones(
  client: FitbitClient, db: mariadb.Connection,
  userId: string, startDate: string, endDate: string
): Promise<number> {
  const data = await client.get<HeartRateResponse>(
    `/1/user/-/activities/heart/date/${startDate}/${endDate}.json`
  );
  let synced = 0;

  for (const day of data["activities-heart"]) {
    for (const zone of day.value.heartRateZones) {
      await db.query(
        `INSERT INTO heart_rate_zones (user_id, date, zone_name, minutes, calories, min_bpm, max_bpm)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE minutes = VALUES(minutes), calories = VALUES(calories),
           min_bpm = VALUES(min_bpm), max_bpm = VALUES(max_bpm)`,
        [userId, day.dateTime, zone.name, zone.minutes, zone.caloriesOut, zone.min, zone.max]
      );
    }
    synced++;
  }

  console.log(`[${userId}] Synced ${synced} days of heart rate zones`);
  return synced;
}

export async function syncHeartRateIntraday(
  client: FitbitClient, db: mariadb.Connection,
  userId: string, date: string
): Promise<number> {
  const data = await client.get<HeartRateResponse>(
    `/1/user/-/activities/heart/date/${date}/1d/1min.json`
  );
  const dataset = data["activities-heart-intraday"]?.dataset;
  if (!dataset || dataset.length === 0) return 0;

  const values = dataset.map((d) => [userId, `${date} ${d.time}`, d.value]);
  await db.batch(
    `INSERT INTO heart_rate_intraday (user_id, ts, bpm) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE bpm = VALUES(bpm)`,
    values
  );

  console.log(`[${userId}] Synced ${values.length} HR intraday points for ${date}`);
  return values.length;
}
