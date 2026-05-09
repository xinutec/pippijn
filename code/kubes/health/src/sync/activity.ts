import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";

interface ActivityResponse {
  "activities-steps": Array<{ dateTime: string; value: string }>;
}

interface DailySummaryResponse {
  summary: {
    steps: number;
    caloriesOut: number;
    activityCalories: number;
    distances: Array<{ activity: string; distance: number }>;
    floors: number;
    elevation: number;
    sedentaryMinutes: number;
    lightlyActiveMinutes: number;
    fairlyActiveMinutes: number;
    veryActiveMinutes: number;
    restingHeartRate?: number;
    activeScore: number;
  };
}

export async function syncActivity(
  client: FitbitClient,
  db: mariadb.Connection,
  startDate: string,
  endDate: string
): Promise<number> {
  let synced = 0;

  // Fetch day by day to get full summaries
  const start = new Date(startDate);
  const end = new Date(endDate);

  for (
    let d = new Date(start);
    d <= end;
    d.setDate(d.getDate() + 1)
  ) {
    const dateStr = d.toISOString().slice(0, 10);

    const data = await client.get<DailySummaryResponse>(
      `/1/user/-/activities/date/${dateStr}.json`
    );

    const s = data.summary;
    const totalDistance =
      s.distances.find((d) => d.activity === "total")?.distance ?? 0;

    await db.query(
      `INSERT INTO daily_activity
        (date, steps, calories_total, calories_active, distance_km,
         floors, elevation_m, minutes_sedentary, minutes_lightly_active,
         minutes_fairly_active, minutes_very_active, active_score,
         resting_heart_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         steps = VALUES(steps),
         calories_total = VALUES(calories_total),
         calories_active = VALUES(calories_active),
         distance_km = VALUES(distance_km),
         floors = VALUES(floors),
         elevation_m = VALUES(elevation_m),
         minutes_sedentary = VALUES(minutes_sedentary),
         minutes_lightly_active = VALUES(minutes_lightly_active),
         minutes_fairly_active = VALUES(minutes_fairly_active),
         minutes_very_active = VALUES(minutes_very_active),
         active_score = VALUES(active_score),
         resting_heart_rate = VALUES(resting_heart_rate)`,
      [
        dateStr,
        s.steps,
        s.caloriesOut,
        s.activityCalories,
        totalDistance,
        s.floors,
        s.elevation,
        s.sedentaryMinutes,
        s.lightlyActiveMinutes,
        s.fairlyActiveMinutes,
        s.veryActiveMinutes,
        s.activeScore,
        s.restingHeartRate ?? null,
      ]
    );

    synced++;

    if (client.rateLimitRemaining <= 10) {
      console.log(
        `Activity sync paused at ${dateStr}, rate limit low (${client.rateLimitRemaining})`
      );
      break;
    }
  }

  console.log(`Synced ${synced} days of activity data`);
  return synced;
}
