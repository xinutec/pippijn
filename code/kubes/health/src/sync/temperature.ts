import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";

interface TemperatureResponse {
  tempSkin: Array<{
    dateTime: string;
    value: { nightlyRelative: number };
  }>;
}

export async function syncTemperature(
  client: FitbitClient,
  db: mariadb.Connection,
  startDate: string,
  endDate: string
): Promise<number> {
  const data = await client.get<TemperatureResponse>(
    `/1/user/-/temp/skin/date/${startDate}/${endDate}.json`
  );

  let synced = 0;

  for (const entry of data.tempSkin) {
    await db.query(
      `INSERT INTO skin_temperature (date, relative_deviation)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         relative_deviation = VALUES(relative_deviation)`,
      [entry.dateTime, entry.value.nightlyRelative]
    );
    synced++;
  }

  console.log(`Synced ${synced} days of skin temperature data`);
  return synced;
}
