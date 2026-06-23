// Kysely row types. DECIMAL columns round-trip as numbers because the pool
// sets `decimalAsNumber: true`; DATETIME round-trips as a JS Date.
export interface MeasurementTable {
	device: string;
	ts: Date;
	temp_c: number | null;
	humidity: number | null;
	co2_ppm: number | null;
	pm01: number | null;
	pm25: number | null;
	pm10: number | null;
	aqi_us: number | null;
	voc_ppb: number | null;
}

export interface SchemaVersionTable {
	version: number;
}

export interface Database {
	measurement: MeasurementTable;
	schema_version: SchemaVersionTable;
}
