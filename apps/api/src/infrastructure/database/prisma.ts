import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';

import type { DatabaseConfig } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

export type DatabaseClient = PrismaClient;

export interface DatabaseClientHooks {
  /** Called for errors on idle pooled connections (e.g. the server restarted). */
  onPoolError?: (err: Error) => void;
}

/**
 * Connection-pool settings for one API process. The pool is created lazily
 * on first query, so the API can boot (and report readiness) even if the
 * database is down, and reconnects automatically once it is back.
 */
export function createPoolConfig(config: DatabaseConfig): PoolConfig {
  return {
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    application_name: 'trackify-api',
  };
}

export function createDatabaseClient(
  config: DatabaseConfig,
  hooks: DatabaseClientHooks = {},
): DatabaseClient {
  const adapter = new PrismaPg(createPoolConfig(config), {
    ...(hooks.onPoolError && {
      onPoolError: hooks.onPoolError,
      onConnectionError: hooks.onPoolError,
    }),
  });
  return new PrismaClient({ adapter });
}
