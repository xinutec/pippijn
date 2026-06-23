import { z } from "zod";

// Environment is validated once at startup; a missing/invalid var fails fast
// rather than surfacing as a confusing runtime error later.
const Env = z.object({
	PORT: z.coerce.number().default(3000),
	DB_HOST: z.string().default("home-db"),
	DB_PORT: z.coerce.number().default(3306),
	DB_USER: z.string(),
	DB_PASSWORD: z.string(),
	DB_NAME: z.string().default("home"),
	// Shared secret the Mac poller presents on POST /api/ingest. Reads are
	// public; only writes are gated, so a leak just lets someone add readings.
	INGEST_TOKEN: z.string().min(16),
});

export interface Config {
	port: number;
	db: {
		host: string;
		port: number;
		user: string;
		password: string;
		database: string;
	};
	ingestToken: string;
}

export function loadConfig(): Config {
	const env = Env.parse(process.env);
	return {
		port: env.PORT,
		db: {
			host: env.DB_HOST,
			port: env.DB_PORT,
			user: env.DB_USER,
			password: env.DB_PASSWORD,
			database: env.DB_NAME,
		},
		ingestToken: env.INGEST_TOKEN,
	};
}
