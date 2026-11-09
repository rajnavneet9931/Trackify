/**
 * Real PostgreSQL integration. Opt-in: runs only when TEST_DATABASE_URL points
 * at a dedicated test database (see README → "Database integration tests").
 * Read-only: issues `SELECT 1` and never creates or modifies objects.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/config/logger.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { buildAppWithDatabase, testConfig } from '../support/database.js';
import { TcpProxy } from '../support/tcp.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full', 'prefer']);

/** Pool config that reaches the real database through a local proxy, keeping TLS/SNI intact. */
function poolConfigVia(proxyPort: number): PoolConfig {
  const url = new URL(TEST_DATABASE_URL);
  const sslMode = url.searchParams.get('sslmode') ?? '';
  return {
    host: '127.0.0.1',
    port: proxyPort,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: TLS_MODES.has(sslMode) ? { servername: url.hostname } : false,
    max: 2,
    connectionTimeoutMillis: 3000,
  };
}

async function waitForStatus(fn: () => Promise<number>, expected: number, attempts = 10) {
  let status = 0;
  for (let i = 0; i < attempts; i++) {
    status = await fn();
    if (status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return status;
}

describe.skipIf(!TEST_DATABASE_URL)('real PostgreSQL', () => {
  it('reports ready (200) when the database is reachable', async () => {
    // Generous timeout: serverless databases may need a few seconds to wake up.
    const config = testConfig(TEST_DATABASE_URL, {
      HEALTH_DB_TIMEOUT_MS: '15000',
      DATABASE_CONNECT_TIMEOUT_MS: '15000',
    });
    const { app, db } = buildAppWithDatabase(config);

    const res = await request(app).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ready', checks: { database: 'up' } });
    await db.$disconnect();
  }, 30_000);

  describe('outage and recovery', () => {
    const target = TEST_DATABASE_URL ? new URL(TEST_DATABASE_URL) : undefined;
    const proxy = new TcpProxy(target?.hostname ?? '', Number(target?.port || 5432));
    let db: PrismaClient;
    let ready: () => Promise<number>;

    beforeAll(async () => {
      await proxy.start();
      const config = testConfig(TEST_DATABASE_URL, { HEALTH_DB_TIMEOUT_MS: '10000' });
      db = new PrismaClient({ adapter: new PrismaPg(poolConfigVia(proxy.port)) });
      const app = createApp({ config, logger: createLogger(config), db });
      ready = async () => (await request(app).get('/api/v1/health/ready')).status;
    });

    afterAll(async () => {
      await db?.$disconnect();
      await proxy.stop();
    });

    it('is ready while the connection is up', async () => {
      expect(await waitForStatus(ready, 200)).toBe(200);
    }, 30_000);

    it('reports 503 when the database connection drops', async () => {
      await proxy.stop();
      const res = await waitForStatus(ready, 503);
      expect(res).toBe(503);
    }, 30_000);

    it('recovers automatically once the database is back', async () => {
      await proxy.start();
      expect(await waitForStatus(ready, 200)).toBe(200);
    }, 30_000);
  });
});
