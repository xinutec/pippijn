import type * as mariadb from "mariadb";
import type { FitbitDevice } from "../../types.js";
import type { FitbitClient } from "../client.js";

export async function syncDevices(client: FitbitClient, conn: mariadb.Connection, userId: string): Promise<number> {
	const devices = await client.get<FitbitDevice[]>(`/1/user/-/devices.json`);

	for (const d of devices) {
		await conn.query(
			`INSERT INTO devices (user_id, device_id, device_version, type, battery, last_sync_time)
       VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
       device_version=VALUES(device_version), type=VALUES(type),
       battery=VALUES(battery), last_sync_time=VALUES(last_sync_time)`,
			[userId, d.id, d.deviceVersion, d.type, d.battery, d.lastSyncTime],
		);
	}

	console.log(`[${userId}] Synced ${devices.length} devices`);
	return devices.length;
}
