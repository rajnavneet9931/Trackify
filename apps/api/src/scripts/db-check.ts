/**
 * Verifies database connectivity using the API's own configuration and pool
 * settings. Prints a credential-free summary and exits 0 (reachable) or 1.
 *
 *   npm run db:check -w @trackify/api
 */
import { ConfigError, loadConfig } from '../config/env.js';
import { summarizeDatabaseError } from '../infrastructure/database/database-errors.js';
import { createDatabaseClient } from '../infrastructure/database/prisma.js';

interface ServerInfo {
  database: string;
  version: string;
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const db = createDatabaseClient(config.database);
  const startedAt = Date.now();

  try {
    const [info] = await db.$queryRaw<ServerInfo[]>`
      SELECT current_database() AS database, current_setting('server_version') AS version`;
    console.log(
      `Database reachable: "${info?.database}" (PostgreSQL ${info?.version}) in ${Date.now() - startedAt}ms`,
    );
    return 0;
  } catch (error) {
    const { kind, code, message } = summarizeDatabaseError(error);
    console.error(`Database unreachable [${kind}${code ? ` ${code}` : ''}]: ${message}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

process.exitCode = await main();
