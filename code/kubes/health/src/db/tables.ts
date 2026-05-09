import type { Generated } from "kysely";

// Each interface maps exactly to a MariaDB table.
// Column names match the SQL schema in schema.ts.
// `Generated<T>` marks columns with DEFAULT values.

export interface TokensTable {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date;
  scopes: string | null;
  updated_at: Generated<Date>;
}

export interface SyncStateTable {
  user_id: string;
  key_name: string;
  value: string;
  updated_at: Generated<Date>;
}

export interface DailyActivityTable {
  user_id: string;
  date: string; // DATE as string in queries
  steps: number | null;
  calories_total: number | null;
  calories_active: number | null;
  distance_km: number | null;
  floors: number | null;
  elevation_m: number | null;
  minutes_sedentary: number | null;
  minutes_lightly_active: number | null;
  minutes_fairly_active: number | null;
  minutes_very_active: number | null;
  active_score: number | null;
  resting_heart_rate: number | null;
  synced_at: Generated<Date>;
}

export interface HeartRateIntradayTable {
  user_id: string;
  ts: string; // DATETIME as string
  bpm: number;
}

export interface HeartRateZonesTable {
  user_id: string;
  date: string;
  zone_name: string;
  minutes: number | null;
  calories: number | null;
  min_bpm: number | null;
  max_bpm: number | null;
}

export interface SleepTable {
  user_id: string;
  log_id: number;
  date: string;
  start_time: string;
  end_time: string;
  duration_ms: number | null;
  efficiency: number | null;
  minutes_asleep: number | null;
  minutes_awake: number | null;
  minutes_deep: number | null;
  minutes_light: number | null;
  minutes_rem: number | null;
  minutes_wake: number | null;
  is_main_sleep: boolean | null;
}

export interface SleepStagesTable {
  user_id: string;
  sleep_log_id: number;
  ts: string;
  stage: string;
  duration_seconds: number;
}

export interface BodyTable {
  user_id: string;
  date: string;
  weight_kg: number | null;
  bmi: number | null;
  body_fat_pct: number | null;
}

export interface SpO2DailyTable {
  user_id: string;
  date: string;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
}

export interface SpO2IntradayTable {
  user_id: string;
  ts: string;
  value: number;
}

export interface HrvDailyTable {
  user_id: string;
  date: string;
  daily_rmssd: number | null;
  deep_rmssd: number | null;
}

export interface BreathingRateTable {
  user_id: string;
  date: string;
  full_sleep_rate: number | null;
  deep_sleep_rate: number | null;
  light_sleep_rate: number | null;
  rem_sleep_rate: number | null;
}

export interface SkinTemperatureTable {
  user_id: string;
  date: string;
  relative_deviation: number | null;
}

export interface CardioFitnessTable {
  user_id: string;
  date: string;
  vo2_max: number | null;
}

export interface DevicesTable {
  user_id: string;
  device_id: string;
  device_version: string | null;
  type: string | null;
  battery: string | null;
  last_sync_time: string | null;
  updated_at: Generated<Date>;
}

export interface SchemaMigrationsTable {
  version: number;
  applied_at: Generated<Date>;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  display_name: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

// The full database interface — Kysely uses this to type-check every query
export interface Database {
  tokens: TokensTable;
  sync_state: SyncStateTable;
  daily_activity: DailyActivityTable;
  heart_rate_intraday: HeartRateIntradayTable;
  heart_rate_zones: HeartRateZonesTable;
  sleep: SleepTable;
  sleep_stages: SleepStagesTable;
  body: BodyTable;
  spo2_daily: SpO2DailyTable;
  spo2_intraday: SpO2IntradayTable;
  hrv_daily: HrvDailyTable;
  breathing_rate: BreathingRateTable;
  skin_temperature: SkinTemperatureTable;
  cardio_fitness: CardioFitnessTable;
  devices: DevicesTable;
  sessions: SessionsTable;
  schema_migrations: SchemaMigrationsTable;
}
