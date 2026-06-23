import type * as mariadb from "mariadb";

// Each migration runs exactly once, tracked by version number. To evolve the
// schema, append a new entry — never modify an existing one.
const MIGRATIONS: readonly string[] = [
	// v1: environmental readings. `device` distinguishes future sensors from the
	// IQAir AirVisual Pro; one row per reading, keyed by (device, ts).
	`CREATE TABLE IF NOT EXISTS measurement (
    device VARCHAR(64) NOT NULL DEFAULT 'airvisual',
    ts DATETIME NOT NULL,
    temp_c DECIMAL(5,2),
    humidity DECIMAL(5,2),
    co2_ppm INT,
    pm01 DECIMAL(6,1),
    pm25 DECIMAL(6,1),
    pm10 DECIMAL(6,1),
    aqi_us INT,
    voc_ppb INT,
    PRIMARY KEY (device, ts),
    INDEX idx_measurement_ts (ts)
  )`,
];

export async function migrate(conn: mariadb.Connection): Promise<void> {
	await conn.query("CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY)");

	// Serialise migrations across restarts/replicas with an advisory lock.
	const lockRows = (await conn.query("SELECT GET_LOCK('home_migrate', 30) AS l")) as Array<{
		l: number | null;
	}>;
	if (lockRows[0]?.l !== 1) {
		throw new Error("could not acquire migration lock");
	}

	try {
		const rows = (await conn.query(
			"SELECT COALESCE(MAX(version), 0) AS v FROM schema_version",
		)) as Array<{ v: number | bigint }>;
		const current = Number(rows[0]?.v ?? 0);
		for (let v = current; v < MIGRATIONS.length; v++) {
			const sql = MIGRATIONS[v];
			if (!sql) continue;
			await conn.query(sql);
			await conn.query("INSERT INTO schema_version (version) VALUES (?)", [v + 1]);
		}
	} finally {
		await conn.query("SELECT RELEASE_LOCK('home_migrate')");
	}
}
