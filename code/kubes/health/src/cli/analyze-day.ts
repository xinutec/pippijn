/**
 * CLI tool: analyze a day's GPS data through the Kalman filter + segment classifier.
 *
 * Usage (from inside the health pod or locally with DB access):
 *   node dist/cli/analyze-day.js [date] [user] [timezone]
 *
 * Default date: yesterday. Default user: pippijn. Default timezone: UTC.
 */

import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { computeVelocity } from "../geo/velocity.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
		nextcloud: z.object({
			baseUrl: z.string().url().default("https://dash.xinutec.org"),
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
		}),
	})
	.parse({
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
			clientId: process.env.NC_CLIENT_ID,
			clientSecret: process.env.NC_CLIENT_SECRET,
		},
	});

const date =
	process.argv[2] ??
	(() => {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		return d.toISOString().slice(0, 10);
	})();

const userId = process.argv[3] ?? "pippijn";
const tz = process.argv[4]; // optional timezone, e.g. "Europe/Amsterdam"

initPool(config.db);
await withConnection(migrate);

console.log(`Analyzing ${date} for user ${userId}${tz ? ` (${tz})` : ""}\n`);

const { points, segments } = await computeVelocity(config, userId, date, tz);

console.log(`Filtered points: ${points.length}`);
console.log(`\n=== Segments (${segments.length}) ===`);
for (const s of segments) {
	const start = new Date(s.startTs * 1000).toISOString().slice(11, 16);
	const end = new Date(s.endTs * 1000).toISOString().slice(11, 16);
	const dur = Math.round((s.endTs - s.startTs) / 60);
	console.log(
		`  ${start}-${end} (${dur.toString().padStart(3)}m) ${s.mode.padEnd(12)} avg:${s.avgSpeed.toString().padStart(5)}km/h max:${s.maxSpeed.toString().padStart(5)}km/h lin:${s.linearity} conf:${s.confidence}`,
	);
}

console.log(`\n=== Points (sampled every ~2 min) ===`);
const sampleInterval = Math.max(1, Math.floor(points.length / 60));
for (let i = 0; i < points.length; i += sampleInterval) {
	const p = points[i];
	const time = new Date(p.ts * 1000).toISOString().slice(11, 16);
	const seg = segments.find((s) => p.ts >= s.startTs && p.ts <= s.endTs);
	console.log(
		`  ${time} lat:${p.lat.toFixed(5)} lon:${p.lon.toFixed(5)} spd:${p.speed_kmh.toString().padStart(5)}km/h brg:${p.bearing.toString().padStart(3)} [${seg?.mode ?? "?"}]`,
	);
}

process.exit(0);
