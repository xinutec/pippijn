import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

export async function syncHrv(
  client: FitbitClient, conn: mariadb.Connection,
  userId: string, startDate: string, endDate: string
): Promise<number> {
  const { hrv } = await client.get<{
    hrv: Array<{ dateTime: string; value: { dailyRmssd: number; deepRmssd: number } }>;
  }>(`/1/user/-/hrv/date/${startDate}/${endDate}.json`);

  for (const e of hrv) {
    await conn.query(
      `INSERT INTO hrv_daily (user_id, date, daily_rmssd, deep_rmssd) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE daily_rmssd=VALUES(daily_rmssd), deep_rmssd=VALUES(deep_rmssd)`,
      [userId, e.dateTime, e.value.dailyRmssd, e.value.deepRmssd]
    );
  }

  console.log(`[${userId}] Synced ${hrv.length} days of HRV`);
  return hrv.length;
}
