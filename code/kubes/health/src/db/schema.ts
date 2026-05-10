import type * as mariadb from "mariadb";

// Each migration runs exactly once, tracked by version number.
// To evolve the schema, add a new entry at the end — never modify existing ones.
const MIGRATIONS: readonly string[] = [
	// v1: initial schema
	`CREATE TABLE IF NOT EXISTS tokens (
    user_id VARCHAR(64) PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    scopes TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
	`CREATE TABLE IF NOT EXISTS sync_state (
    user_id VARCHAR(64) NOT NULL,
    key_name VARCHAR(64) NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key_name)
  )`,
	`CREATE TABLE IF NOT EXISTS daily_activity (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    steps INT,
    calories_total INT,
    calories_active INT,
    distance_km DECIMAL(8,3),
    floors INT,
    elevation_m DECIMAL(8,2),
    minutes_sedentary INT,
    minutes_lightly_active INT,
    minutes_fairly_active INT,
    minutes_very_active INT,
    active_score INT,
    resting_heart_rate INT,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS heart_rate_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    bpm SMALLINT NOT NULL,
    PRIMARY KEY (user_id, ts)
  )`,
	`CREATE TABLE IF NOT EXISTS heart_rate_zones (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    zone_name VARCHAR(32) NOT NULL,
    minutes INT,
    calories DECIMAL(8,2),
    min_bpm INT,
    max_bpm INT,
    PRIMARY KEY (user_id, date, zone_name)
  )`,
	`CREATE TABLE IF NOT EXISTS sleep (
    user_id VARCHAR(64) NOT NULL,
    log_id BIGINT NOT NULL,
    date DATE NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    duration_ms BIGINT,
    efficiency INT,
    minutes_asleep INT,
    minutes_awake INT,
    minutes_deep INT,
    minutes_light INT,
    minutes_rem INT,
    minutes_wake INT,
    is_main_sleep BOOLEAN,
    PRIMARY KEY (user_id, log_id),
    INDEX idx_sleep_user_date (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS sleep_stages (
    user_id VARCHAR(64) NOT NULL,
    sleep_log_id BIGINT NOT NULL,
    ts DATETIME NOT NULL,
    stage VARCHAR(16) NOT NULL,
    duration_seconds INT NOT NULL,
    PRIMARY KEY (user_id, sleep_log_id, ts)
  )`,
	`CREATE TABLE IF NOT EXISTS body (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    weight_kg DECIMAL(5,2),
    bmi DECIMAL(4,1),
    body_fat_pct DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS spo2_daily (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    avg_value DECIMAL(4,1),
    min_value DECIMAL(4,1),
    max_value DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS spo2_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    value DECIMAL(4,1) NOT NULL,
    PRIMARY KEY (user_id, ts)
  )`,
	`CREATE TABLE IF NOT EXISTS hrv_daily (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    daily_rmssd DECIMAL(8,2),
    deep_rmssd DECIMAL(8,2),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS breathing_rate (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    full_sleep_rate DECIMAL(4,1),
    deep_sleep_rate DECIMAL(4,1),
    light_sleep_rate DECIMAL(4,1),
    rem_sleep_rate DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS skin_temperature (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    relative_deviation DECIMAL(4,2),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS cardio_fitness (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    vo2_max DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS devices (
    user_id VARCHAR(64) NOT NULL,
    device_id VARCHAR(64) NOT NULL,
    device_version VARCHAR(64),
    type VARCHAR(32),
    battery VARCHAR(16),
    last_sync_time DATETIME,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id)
  )`,

	// v16: persistent sessions
	`CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_expires (expires_at)
  )`,

	// v17: Nextcloud OAuth tokens (for PhoneTrack API access)
	`CREATE TABLE IF NOT EXISTS nc_tokens (
    user_id VARCHAR(64) PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

	// v18: OSM query cache (Nominatim reverse geocoding + Overpass nearby ways).
	// Keyed by query type and rounded coordinates (~11m precision at 4 decimals).
	`CREATE TABLE IF NOT EXISTS osm_cache (
    query_type VARCHAR(32) NOT NULL,
    lat_rounded DECIMAL(7,4) NOT NULL,
    lon_rounded DECIMAL(7,4) NOT NULL,
    result LONGTEXT NOT NULL,
    cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (query_type, lat_rounded, lon_rounded)
  )`,

	// v19: Detected focus places (home, work, frequent café, ...). Refreshed
	// weekly by re-fetching the user's last 90 days from PhoneTrack and
	// running the focus-places pipeline. Whole table per user is rebuilt each
	// refresh — no stable IDs across rebuilds. Used by velocity.ts for
	// snap-to-place during live timeline rendering.
	`CREATE TABLE IF NOT EXISTS focus_places (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    centroid_lat DECIMAL(9,6) NOT NULL,
    centroid_lon DECIMAL(9,6) NOT NULL,
    radius_m INT NOT NULL,
    total_dwell_sec BIGINT NOT NULL,
    visit_count INT NOT NULL,
    unique_days INT NOT NULL,
    first_seen_ts INT UNSIGNED NOT NULL,
    last_seen_ts INT UNSIGNED NOT NULL,
    detected_label VARCHAR(32),
    refreshed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_fp_user (user_id),
    INDEX idx_fp_user_geo (user_id, centroid_lat, centroid_lon)
  )`,

	// v20: Auto-derived display name for the user's primary clusters
	// ("Home" — strongest overnight cluster, "Work" — strongest non-home
	// weekday-daytime cluster). NULL for places without a special role;
	// those fall back to OSM nearby-landmark labelling at render time.
	`ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS display_name VARCHAR(64) NULL`,

	// v21: Per-cluster sum of stay durations where the stay covers any of
	// 02:00–06:00 local solar time (deep night). This is the residential /
	// "I sleep here sometimes" signal — robust to people who sleep
	// 22:00-09:00 or 02:00-10:00, robust to long café visits (which don't
	// cross deep night). Used by velocity.ts to label any stay at the
	// cluster with the address rather than the closest amenity, regardless
	// of this particular stay's time-of-day.
	`ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS sleep_hours INT NULL`,

	// Future migrations go here.
];

export async function migrate(conn: mariadb.Connection): Promise<void> {
	// MariaDB advisory lock so only one process runs migrations at a time.
	// Today health-auth has replicas=1 and sync runs as a separate cron, so
	// genuine concurrent migrations don't happen — but a rolling deploy or
	// scale-up could trigger two pods to call migrate() simultaneously, and
	// MariaDB DDL is non-transactional, so a race could double-fail or apply
	// half a migration. The lock is cheap insurance.
	const lockRows = (await conn.query("SELECT GET_LOCK('health_migrate', 30) AS got")) as Array<{ got: number | null }>;
	if (lockRows[0]?.got !== 1) {
		throw new Error("Failed to acquire schema_migrations advisory lock within 30s");
	}

	try {
		// Create tracking table (idempotent)
		await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

		// Find which migrations have already run
		const applied = await conn.query("SELECT version FROM schema_migrations ORDER BY version");
		const appliedSet = new Set<number>(applied.map((r: { version: number }) => r.version));

		let ran = 0;
		for (let i = 0; i < MIGRATIONS.length; i++) {
			if (appliedSet.has(i)) continue;

			await conn.query(MIGRATIONS[i]);
			await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [i]);
			ran++;
		}

		if (ran > 0) {
			console.log(`Ran ${ran} migration(s) (${appliedSet.size} already applied, ${MIGRATIONS.length} total)`);
		} else {
			console.log(`Schema up to date (${MIGRATIONS.length} migrations)`);
		}
	} finally {
		await conn.query("SELECT RELEASE_LOCK('health_migrate')");
	}
}
