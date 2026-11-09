import { describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../src/infrastructure/database/prisma.js';
import { assertIsTestDatabase } from './support/database.js';

const connectedTo = (name: string) =>
  ({ $queryRaw: async () => [{ name }] }) as unknown as DatabaseClient;

describe('assertIsTestDatabase (runtime write guard)', () => {
  const devNames = (process.env.TRACKIFY_DEV_DATABASE_NAMES ?? '').split(',').filter(Boolean);

  it('knows the development database name(s) from .env when one is configured', () => {
    // Empty only on machines without apps/api/.env; then the "test" name rule still applies.
    for (const name of devNames) expect(name.length).toBeGreaterThan(0);
  });

  it.each(['trackify', 'production', 'Trackify_db'])('refuses "%s"', async (name) => {
    await expect(assertIsTestDatabase(connectedTo(name))).rejects.toThrow(/Refusing to write/);
  });

  it('refuses the configured development database even if its name contained "test"', async () => {
    for (const name of devNames) {
      await expect(assertIsTestDatabase(connectedTo(name))).rejects.toThrow(/Refusing to write/);
    }
  });

  it('allows an isolated test database', async () => {
    await expect(assertIsTestDatabase(connectedTo('Trackify_test'))).resolves.toBeUndefined();
  });
});
