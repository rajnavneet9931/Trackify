/**
 * Registration against the real, isolated test database (TEST_DATABASE_URL).
 * Requires migrations: `npm run db:test:deploy`. Every row uses a per-run
 * email domain and is deleted afterwards; nothing else is touched.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { argon2PasswordHasher } from '../../src/modules/auth/password-hasher.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const URL = '/api/v1/auth/register';
const PASSWORD = 'correct horse battery staple';
const RUN_DOMAIN = `int-${randomUUID().slice(0, 8)}.trackify.test`;
const email = (local: string) => `${local}@${RUN_DOMAIN}`;

describe.skipIf(!TEST_DATABASE_URL)('registration with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;

  beforeAll(async () => {
    const config = testConfig(TEST_DATABASE_URL, {
      DATABASE_POOL_MAX: '5',
      DATABASE_CONNECT_TIMEOUT_MS: '15000',
    });
    ({ app, db } = buildAppWithDatabase(config));
    await assertIsTestDatabase(db);

    const [table] = await db.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public.users') IS NOT NULL AS "exists"`;
    if (!table?.exists) {
      throw new Error('Test database is not migrated. Run: npm run db:test:deploy');
    }
  }, 30_000);

  afterAll(async () => {
    await db?.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db?.$disconnect();
  });

  it('persists the user with a normalized email and an Argon2id hash', async () => {
    const res = await request(app)
      .post(URL)
      .send({ email: `  Ada.Lovelace@${RUN_DOMAIN.toUpperCase()} `, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      email: email('ada.lovelace'),
      createdAt: expect.any(String),
    });

    const row = await db.user.findUniqueOrThrow({ where: { email: email('ada.lovelace') } });
    expect(row.id).toBe(res.body.data.user.id);
    expect(row.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
    await expect(argon2PasswordHasher.verify(row.passwordHash, PASSWORD)).resolves.toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(row.passwordHash);
  }, 30_000);

  it('rejects a duplicate email (different casing) with 409 and keeps one row', async () => {
    const first = await request(app)
      .post(URL)
      .send({ email: email('grace'), password: PASSWORD });
    const second = await request(app)
      .post(URL)
      .send({ email: email('GRACE'), password: 'a different passphrase' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
    expect(JSON.stringify(second.body)).not.toMatch(/users_email_key|23505|P2002|prisma/i);
    expect(await db.user.count({ where: { email: email('grace') } })).toBe(1);
  }, 30_000);

  it('lets exactly one of several concurrent duplicate registrations succeed', async () => {
    const attempts = 6;
    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        request(app)
          .post(URL)
          .send({ email: i % 2 ? email('race') : email('RACE'), password: `${PASSWORD} ${i}` }),
      ),
    );

    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([201, ...Array<number>(attempts - 1).fill(409)]);
    expect(await db.user.count({ where: { email: email('race') } })).toBe(1);
  }, 60_000);

  it('does not persist anything for invalid input', async () => {
    const res = await request(app)
      .post(URL)
      .send({ email: email('mallory'), password: PASSWORD, role: 'admin' });

    expect(res.status).toBe(400);
    expect(await db.user.count({ where: { email: email('mallory') } })).toBe(0);
  });
});
