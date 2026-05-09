import * as mariadb from "mariadb";

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function getDbConfig(): DbConfig {
  return {
    host: process.env.DB_HOST ?? "health-db",
    port: parseInt(process.env.DB_PORT ?? "3306", 10),
    user: process.env.DB_USER ?? "health",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "health",
  };
}

export async function connect(config?: DbConfig): Promise<mariadb.Connection> {
  const cfg = config ?? getDbConfig();
  return mariadb.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });
}
