import type { Express } from 'express';

import { createApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/config/logger.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../src/infrastructure/database/prisma.js';

/** Test config pointing at `databaseUrl`, with short timeouts so failures surface quickly. */
export function testConfig(databaseUrl: string, overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '2',
    DATABASE_CONNECT_TIMEOUT_MS: '2000',
    HEALTH_DB_TIMEOUT_MS: '3000',
    ...overrides,
  });
}

/** Builds the real app wired to a real Prisma client (no repository overrides). */
export function buildAppWithDatabase(config: AppConfig): { app: Express; db: DatabaseClient } {
  const db = createDatabaseClient(config.database);
  const app = createApp({ config, logger: createLogger(config), db });
  return { app, db };
}

/** Strings that must never appear in a client-facing response. */
export function sensitiveFragments(databaseUrl: string): string[] {
  const url = new URL(databaseUrl);
  return [
    databaseUrl,
    url.hostname,
    decodeURIComponent(url.password),
    decodeURIComponent(url.username),
    'prisma',
    'SELECT',
    'stack',
  ].filter((fragment) => fragment.length > 0);
}

/**
 * Runtime guard for every integration suite that writes: asks the server which
 * database this connection actually reached. It must look like a test database
 * and must not be the development database configured in .env. Complements the
 * URL comparison in vitest.config.ts, which cannot see aliases or DNS tricks.
 */
export async function assertIsTestDatabase(db: DatabaseClient): Promise<void> {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  assertTestDatabaseName(row?.name ?? '');
}

/**
 * The rule itself, for connections that are not Prisma clients (e.g. a raw
 * `pg` client): pass the result of `SELECT current_database()`.
 */
export function assertTestDatabaseName(name: string): void {
  const devNames = (process.env.TRACKIFY_DEV_DATABASE_NAMES ?? '').split(',').filter(Boolean);

  if (!/test/i.test(name) || devNames.includes(name)) {
    throw new Error(
      `Refusing to write: connected database "${name}" is not an isolated test database.`,
    );
  }
}
