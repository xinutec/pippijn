import type * as mariadb from "mariadb";
import type { FitbitClient } from "../fitbit/client.js";
import type { Device } from "../fitbit/types.js";

export async function syncDevices(
  client: FitbitClient, db: mariadb.Connection, userId: string
): Promise<number> {
  const devices = await client.get<Device[]>(`/1/user/-/devices.json`);

  for (const dev of devices) {
    await db.query(
      `INSERT INTO devices (user_id, device_id, device_version, type, battery, last_sync_time)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE device_version = VALUES(device_version), type = VALUES(type),
         battery = VALUES(battery), last_sync_time = VALUES(last_sync_time)`,
      [userId, dev.id, dev.deviceVersion, dev.type, dev.battery, dev.lastSyncTime]
    );
  }

  console.log(`[${userId}] Synced ${devices.length} devices`);
  return devices.length;
}
