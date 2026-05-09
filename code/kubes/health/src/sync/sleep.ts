import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";
import type { SleepLog } from "../fitbit/types.js";

interface SleepResponse {
  sleep: SleepLog[];
}

export async function syncSleep(
  client: FitbitClient,
  db: mariadb.Connection,
  startDate: string,
  endDate: string
): Promise<number> {
  // Sleep API supports date ranges up to 100 days
  const data = await client.get<SleepResponse>(
    `/1.2/user/-/sleep/date/${startDate}/${endDate}.json`
  );

  let synced = 0;

  for (const log of data.sleep) {
    await db.query(
      `INSERT INTO sleep
        (log_id, date, start_time, end_time, duration_ms, efficiency,
         minutes_asleep, minutes_awake, minutes_deep, minutes_light,
         minutes_rem, minutes_wake, is_main_sleep)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         start_time = VALUES(start_time),
         end_time = VALUES(end_time),
         duration_ms = VALUES(duration_ms),
         efficiency = VALUES(efficiency),
         minutes_asleep = VALUES(minutes_asleep),
         minutes_awake = VALUES(minutes_awake),
         minutes_deep = VALUES(minutes_deep),
         minutes_light = VALUES(minutes_light),
         minutes_rem = VALUES(minutes_rem),
         minutes_wake = VALUES(minutes_wake),
         is_main_sleep = VALUES(is_main_sleep)`,
      [
        log.logId,
        log.dateOfSleep,
        log.startTime,
        log.endTime,
        log.duration,
        log.efficiency,
        log.minutesAsleep,
        log.minutesAwake,
        log.levels?.summary.deep?.minutes ?? null,
        log.levels?.summary.light?.minutes ?? null,
        log.levels?.summary.rem?.minutes ?? null,
        log.levels?.summary.wake?.minutes ?? null,
        log.isMainSleep,
      ]
    );

    // Upsert sleep stages
    if (log.levels?.data) {
      for (const stage of log.levels.data) {
        await db.query(
          `INSERT INTO sleep_stages (sleep_log_id, ts, stage, duration_seconds)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             stage = VALUES(stage),
             duration_seconds = VALUES(duration_seconds)`,
          [log.logId, stage.dateTime, stage.level, stage.seconds]
        );
      }
    }

    synced++;
  }

  console.log(`Synced ${synced} sleep logs`);
  return synced;
}
