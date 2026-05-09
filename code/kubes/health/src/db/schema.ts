import type * as mariadb from "mariadb";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS sync_state (
    key_name VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS tokens (
    id INT PRIMARY KEY DEFAULT 1,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    scopes TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS daily_activity (
    date DATE PRIMARY KEY,
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
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS heart_rate_intraday (
    ts DATETIME NOT NULL,
    bpm SMALLINT NOT NULL,
    PRIMARY KEY (ts)
  )`,

  `CREATE TABLE IF NOT EXISTS heart_rate_zones (
    date DATE NOT NULL,
    zone_name VARCHAR(32) NOT NULL,
    minutes INT,
    calories DECIMAL(8,2),
    min_bpm INT,
    max_bpm INT,
    PRIMARY KEY (date, zone_name)
  )`,

  `CREATE TABLE IF NOT EXISTS sleep (
    log_id BIGINT PRIMARY KEY,
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
    INDEX idx_sleep_date (date)
  )`,

  `CREATE TABLE IF NOT EXISTS sleep_stages (
    sleep_log_id BIGINT NOT NULL,
    ts DATETIME NOT NULL,
    stage VARCHAR(16) NOT NULL,
    duration_seconds INT NOT NULL,
    PRIMARY KEY (sleep_log_id, ts),
    FOREIGN KEY (sleep_log_id) REFERENCES sleep(log_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS body (
    date DATE PRIMARY KEY,
    weight_kg DECIMAL(5,2),
    bmi DECIMAL(4,1),
    body_fat_pct DECIMAL(4,1)
  )`,

  `CREATE TABLE IF NOT EXISTS spo2_daily (
    date DATE PRIMARY KEY,
    avg_value DECIMAL(4,1),
    min_value DECIMAL(4,1),
    max_value DECIMAL(4,1)
  )`,

  `CREATE TABLE IF NOT EXISTS spo2_intraday (
    ts DATETIME NOT NULL,
    value DECIMAL(4,1) NOT NULL,
    PRIMARY KEY (ts)
  )`,

  `CREATE TABLE IF NOT EXISTS hrv_daily (
    date DATE PRIMARY KEY,
    daily_rmssd DECIMAL(8,2),
    deep_rmssd DECIMAL(8,2)
  )`,

  `CREATE TABLE IF NOT EXISTS breathing_rate (
    date DATE PRIMARY KEY,
    full_sleep_rate DECIMAL(4,1),
    deep_sleep_rate DECIMAL(4,1),
    light_sleep_rate DECIMAL(4,1),
    rem_sleep_rate DECIMAL(4,1)
  )`,

  `CREATE TABLE IF NOT EXISTS skin_temperature (
    date DATE PRIMARY KEY,
    relative_deviation DECIMAL(4,2)
  )`,

  `CREATE TABLE IF NOT EXISTS cardio_fitness (
    date DATE PRIMARY KEY,
    vo2_max DECIMAL(4,1)
  )`,

  `CREATE TABLE IF NOT EXISTS devices (
    device_id VARCHAR(64) PRIMARY KEY,
    device_version VARCHAR(64),
    type VARCHAR(32),
    battery VARCHAR(16),
    last_sync_time DATETIME,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
];

export async function migrate(conn: mariadb.Connection): Promise<void> {
  for (const ddl of TABLES) {
    await conn.query(ddl);
  }
  console.log(`Schema migration complete (${TABLES.length} tables)`);
}
