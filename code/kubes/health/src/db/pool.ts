import { Kysely } from "kysely";
import { MariadbDialect } from "kysely-mariadb";
import * as mariadb from "mariadb";
import type { Config } from "../config.js";
import type { Database } from "./tables.js";

let pool: mariadb.Pool | null = null;
let kyselyInstance: Kysely<Database> | null = null;

export function initPool(config: Config["db"]): mariadb.Pool {
	pool = mariadb.createPool({
		host: config.host,
		port: config.port,
		user: config.user,
		password: config.password,
		database: config.database,
		connectionLimit: 5,
		bigIntAsNumber: true,
	});

	kyselyInstance = new Kysely<Database>({
		dialect: new MariadbDialect({ mariadb: pool }),
	});

	return pool;
}

export function getPool(): mariadb.Pool {
	if (!pool) throw new Error("DB pool not initialized. Call initPool first.");
	return pool;
}

export function db(): Kysely<Database> {
	if (!kyselyInstance) throw new Error("DB not initialized. Call initPool first.");
	return kyselyInstance;
}

// Raw connection for migrations (which use DDL, not Kysely)
export async function withConnection<T>(fn: (conn: mariadb.Connection) => Promise<T>): Promise<T> {
	const conn = await getPool().getConnection();
	try {
		return await fn(conn);
	} finally {
		conn.release();
	}
}

export async function destroyPool(): Promise<void> {
	if (kyselyInstance) {
		await kyselyInstance.destroy(); // also closes the underlying pool
	} else {
		await pool?.end();
	}
	kyselyInstance = null;
	pool = null;
}
