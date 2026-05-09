import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";

interface HrvResponse {
  hrv: Array<{ dateTime: string; value: { dailyRmssd: number; deepRmssd: number } }>;
}

export async function syncHrv(
  client: FitbitClient, db: mariadb.Connection,
  userId: string, startDate: string, endDate: string
): Promise<number> {
  const data = await client.get<HrvResponse>(
    `/1/user/-/hrv/date/${startDate}/${endDate}.json`
  );
  let synced = 0;

  for (const entry of data.hrv) {
    await db.query(
      `INSERT INTO hrv_daily (user_id, date, daily_rmssd, deep_rmssd)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE daily_rmssd = VALUES(daily_rmssd), deep_rmssd = VALUES(deep_rmssd)`,
      [userId, entry.dateTime, entry.value.dailyRmssd, entry.value.deepRmssd]
    );
    synced++;
  }

  console.log(`[${userId}] Synced ${synced} days of HRV`);
  return synced;
}
