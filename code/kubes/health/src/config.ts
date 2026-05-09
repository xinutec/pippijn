import { z } from "zod";

const schema = z.object({
	port: z.coerce.number().default(3000),

	db: z.object({
		host: z.string().default("health-db"),
		port: z.coerce.number().default(3306),
		user: z.string(),
		password: z.string(),
		database: z.string().default("health"),
	}),

	fitbit: z.object({
		clientId: z.string().min(1),
		clientSecret: z.string().min(1),
		redirectUri: z.string().url().default("https://health.xinutec.org/fitbit/callback"),
	}),

	nextcloud: z.object({
		baseUrl: z.string().url().default("https://dash.xinutec.org"),
		clientId: z.string().min(1),
		clientSecret: z.string().min(1),
		redirectUri: z.string().url().default("https://health.xinutec.org/auth/callback"),
	}),

	sessionSecret: z.string().min(16),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
	return schema.parse({
		port: process.env.AUTH_PORT,
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
		fitbit: {
			clientId: process.env.FITBIT_CLIENT_ID,
			clientSecret: process.env.FITBIT_CLIENT_SECRET,
			redirectUri: process.env.FITBIT_REDIRECT_URI,
		},
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
			clientId: process.env.NC_CLIENT_ID,
			clientSecret: process.env.NC_CLIENT_SECRET,
			redirectUri: process.env.NC_REDIRECT_URI,
		},
		sessionSecret: process.env.SESSION_SECRET,
	});
}

// Lighter config for sync job (Fitbit only, no Nextcloud needed)
export function loadSyncConfig() {
	return z
		.object({
			db: schema.shape.db,
			fitbit: z.object({
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
			fitbit: {
				clientId: process.env.FITBIT_CLIENT_ID,
				clientSecret: process.env.FITBIT_CLIENT_SECRET,
			},
		});
}
