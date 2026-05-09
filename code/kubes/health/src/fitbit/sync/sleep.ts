import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

interface SleepResponse {
  sleep: Array<{
    logId: number; dateOfSleep: string; startTime: string; endTime: string;
    duration: number; efficiency: number; minutesAsleep: number; minutesAwake: number;
    isMainSleep: boolean;
    levels?: {
      summary: { deep?: { minutes: number }; light?: { minutes: number }; rem?: { minutes: number }; wake?: { minutes: number } };
      data: Array<{ dateTime: string; level: string; seconds: number }>;
    };
  }>;
}

export async function syncSleep(
  client: FitbitClient, conn: mariadb.Connection,
  userId: string, startDate: string, endDate: string
): Promise<number> {
  const { sleep } = await client.get<SleepResponse>(
    `/1.2/user/-/sleep/date/${startDate}/${endDate}.json`
  );

  for (const log of sleep) {
    await conn.query(
      `INSERT INTO sleep (user_id, log_id, date, start_time, end_time, duration_ms, efficiency,
         minutes_asleep, minutes_awake, minutes_deep, minutes_light, minutes_rem, minutes_wake, is_main_sleep)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE start_time=VALUES(start_time), end_time=VALUES(end_time),
         duration_ms=VALUES(duration_ms), efficiency=VALUES(efficiency),
         minutes_asleep=VALUES(minutes_asleep), minutes_awake=VALUES(minutes_awake),
         minutes_deep=VALUES(minutes_deep), minutes_light=VALUES(minutes_light),
         minutes_rem=VALUES(minutes_rem), minutes_wake=VALUES(minutes_wake),
         is_main_sleep=VALUES(is_main_sleep)`,
      [userId, log.logId, log.dateOfSleep, log.startTime, log.endTime,
       log.duration, log.efficiency, log.minutesAsleep, log.minutesAwake,
       log.levels?.summary.deep?.minutes ?? null, log.levels?.summary.light?.minutes ?? null,
       log.levels?.summary.rem?.minutes ?? null, log.levels?.summary.wake?.minutes ?? null,
       log.isMainSleep]
    );

    if (log.levels?.data) {
      for (const stage of log.levels.data) {
        await conn.query(
          `INSERT INTO sleep_stages (user_id, sleep_log_id, ts, stage, duration_seconds)
           VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE stage=VALUES(stage), duration_seconds=VALUES(duration_seconds)`,
          [userId, log.logId, stage.dateTime, stage.level, stage.seconds]
        );
      }
    }
  }

  console.log(`[${userId}] Synced ${sleep.length} sleep logs`);
  return sleep.length;
}
