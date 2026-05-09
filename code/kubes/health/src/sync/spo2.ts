import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";

interface SpO2Response {
  dateTime: string;
  value: { avg: number; min: number; max: number };
}

interface SpO2IntradayResponse {
  dateTime: string;
  minutes: Array<{ value: number; minute: string }>;
}

export async function syncSpO2Daily(
  client: FitbitClient,
  db: mariadb.Connection,
  startDate: string,
  endDate: string
): Promise<number> {
  const data = await client.get<SpO2Response[]>(
    `/1/user/-/spo2/date/${startDate}/${endDate}.json`
  );

  let synced = 0;

  for (const entry of data) {
    await db.query(
      `INSERT INTO spo2_daily (date, avg_value, min_value, max_value)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         avg_value = VALUES(avg_value),
         min_value = VALUES(min_value),
         max_value = VALUES(max_value)`,
      [entry.dateTime, entry.value.avg, entry.value.min, entry.value.max]
    );
    synced++;
  }

  console.log(`Synced ${synced} days of SpO2 data`);
  return synced;
}

export async function syncSpO2Intraday(
  client: FitbitClient,
  db: mariadb.Connection,
  date: string
): Promise<number> {
  const data = await client.get<SpO2IntradayResponse>(
    `/1/user/-/spo2/date/${date}/all.json`
  );

  if (!data.minutes || data.minutes.length === 0) return 0;

  const values = data.minutes.map((m) => [
    `${date} ${m.minute}`,
    m.value,
  ]);

  await db.batch(
    `INSERT INTO spo2_intraday (ts, value)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    values
  );

  console.log(`Synced ${values.length} SpO2 intraday points for ${date}`);
  return values.length;
}
