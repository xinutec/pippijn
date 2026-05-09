import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";

interface BreathingRateResponse {
  br: Array<{
    dateTime: string;
    value: {
      breathingRate: number;
      fullSleepSummary?: { breathingRate: number };
      deepSleepSummary?: { breathingRate: number };
      lightSleepSummary?: { breathingRate: number };
      remSleepSummary?: { breathingRate: number };
    };
  }>;
}

export async function syncBreathingRate(
  client: FitbitClient, db: mariadb.Connection,
  userId: string, startDate: string, endDate: string
): Promise<number> {
  const data = await client.get<BreathingRateResponse>(
    `/1/user/-/br/date/${startDate}/${endDate}.json`
  );
  let synced = 0;

  for (const entry of data.br) {
    const v = entry.value;
    await db.query(
      `INSERT INTO breathing_rate (user_id, date, full_sleep_rate, deep_sleep_rate, light_sleep_rate, rem_sleep_rate)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE full_sleep_rate = VALUES(full_sleep_rate), deep_sleep_rate = VALUES(deep_sleep_rate),
         light_sleep_rate = VALUES(light_sleep_rate), rem_sleep_rate = VALUES(rem_sleep_rate)`,
      [userId, entry.dateTime, v.fullSleepSummary?.breathingRate ?? v.breathingRate,
       v.deepSleepSummary?.breathingRate ?? null, v.lightSleepSummary?.breathingRate ?? null,
       v.remSleepSummary?.breathingRate ?? null]
    );
    synced++;
  }

  console.log(`[${userId}] Synced ${synced} days of breathing rate`);
  return synced;
}
