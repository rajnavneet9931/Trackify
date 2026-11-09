/**
 * Login and sessions against the real, isolated test database. Rows are
 * created under a per-run email domain; deleting those users cascades to
 * their sessions.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN_DOMAIN = `int-${randomUUID().slice(0, 8)}.trackify.test`;
const email = (local: string) => `${local}@${RUN_DOMAIN}`;

function tokenFrom(res: request.Response): string {
  const header = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '';
  return header.split(';')[0]!.split('=')[1] ?? '';
}
const cookie = (token: string) => `trackify_session=${token}`;
const sha256 = (token: string) => createHash('sha256').update(token).digest();

describe.skipIf(!TEST_DATABASE_URL)('login and sessions with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;

  const register = (address: string) =>
    request(app).post('/api/v1/auth/register').send({ email: address, password: PASSWORD });
  const login = (address: string, password = PASSWORD, token?: string) => {
    const req = request(app).post('/api/v1/auth/login');
    if (token) req.set('Cookie', cookie(token));
    return req.send({ email: address, password });
  };
  const me = (token: string) => request(app).get('/api/v1/auth/me').set('Cookie', cookie(token));
  const sessionsOf = (address: string) =>
    db.session.findMany({ where: { user: { email: address } }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '5',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
    const [table] = await db.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public.sessions') IS NOT NULL AS "exists"`;
    if (!table?.exists)
      throw new Error('Test database is not migrated. Run: npm run db:test:deploy');
  }, 30_000);

  afterAll(async () => {
    await db?.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db?.$disconnect();
  });

  it('logs in, stores only SHA-256(token), and authenticates /me', async () => {
    expect((await register(email('ada'))).status).toBe(201);

    const res = await login(` ${email('ADA')} `);
    const token = tokenFrom(res);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email('ada'));

    const [row] = await sessionsOf(email('ada'));
    expect(row).toBeDefined();
    expect(Buffer.from(row!.tokenHash).equals(sha256(token))).toBe(true);
    expect(Buffer.from(row!.tokenHash).toString('base64url')).not.toBe(token);
    expect(
      JSON.stringify(row, (_k, v) =>
        v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
      ),
    ).not.toContain(token);
    expect(row!.expiresAt.getTime()).toBe(new Date(res.body.data.expiresAt).getTime());

    const current = await me(token);
    expect(current.status).toBe(200);
    expect(current.body.data).toMatchObject({
      user: { id: row!.userId, email: email('ada') },
      csrfToken: res.body.data.csrfToken,
    });
  }, 30_000);

  it('returns the same 401 for an unknown email and a wrong password', async () => {
    await register(email('grace'));
    const unknown = await login(email('nobody'));
    const wrong = await login(email('grace'), 'not the right password');

    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect({ ...unknown.body.error, requestId: 0 }).toEqual({ ...wrong.body.error, requestId: 0 });
    expect(await sessionsOf(email('grace'))).toHaveLength(0);
  }, 30_000);

  it('rejects expired sessions and cleans them up on the next login', async () => {
    await register(email('expiry'));
    const token = tokenFrom(await login(email('expiry')));
    await db.session.updateMany({
      where: { user: { email: email('expiry') } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await me(token)).status).toBe(401);

    await login(email('expiry'));
    const rows = await sessionsOf(email('expiry'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  }, 30_000);

  it('rotates: logging in with an existing cookie replaces that session', async () => {
    await register(email('rotate'));
    const first = tokenFrom(await login(email('rotate')));
    const second = tokenFrom(await login(email('rotate'), PASSWORD, first));

    expect(second).not.toBe(first);
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
    const rows = await sessionsOf(email('rotate'));
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.tokenHash).equals(sha256(second))).toBe(true);
  }, 30_000);

  it('revokes immediately when the session row is deleted', async () => {
    await register(email('revoke'));
    const token = tokenFrom(await login(email('revoke')));
    await db.session.deleteMany({ where: { tokenHash: sha256(token) } });

    expect((await me(token)).status).toBe(401);
  }, 30_000);

  it('cascades: deleting a user removes their sessions', async () => {
    await register(email('cascade'));
    const token = tokenFrom(await login(email('cascade')));
    await db.user.delete({ where: { email: email('cascade') } });

    expect(await db.session.count({ where: { tokenHash: sha256(token) } })).toBe(0);
    expect((await me(token)).status).toBe(401);
  }, 30_000);

  describe('logout', () => {
    const signIn = async (address: string) => {
      const res = await login(address);
      return { token: tokenFrom(res), csrfToken: res.body.data.csrfToken as string };
    };
    const logout = (device: { token: string; csrfToken: string }, csrf = device.csrfToken) =>
      request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie(device.token))
        .set('X-CSRF-Token', csrf);

    it('deletes only the current session row and invalidates its cookie', async () => {
      await register(email('logout'));
      const laptop = await signIn(email('logout'));
      const phone = await signIn(email('logout'));
      expect(await sessionsOf(email('logout'))).toHaveLength(2);

      const res = await logout(laptop);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { loggedOut: true } });
      expect(([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]).toMatch(
        /^trackify_session=; Path=\/api; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/,
      );
      expect(await db.session.count({ where: { tokenHash: sha256(laptop.token) } })).toBe(0);
      expect(await db.session.count({ where: { tokenHash: sha256(phone.token) } })).toBe(1);

      expect((await me(laptop.token)).status).toBe(401);
      expect((await me(phone.token)).status).toBe(200);
      expect((await logout(laptop)).status).toBe(401);
    }, 30_000);

    it('keeps the session when the CSRF token is wrong', async () => {
      await register(email('logout-csrf'));
      const device = await signIn(email('logout-csrf'));

      expect((await logout(device, 'forged-token')).status).toBe(403);
      expect(await db.session.count({ where: { tokenHash: sha256(device.token) } })).toBe(1);
    }, 30_000);

    it('rejects an expired session with 401', async () => {
      await register(email('logout-expired'));
      const device = await signIn(email('logout-expired'));
      await db.session.updateMany({
        where: { tokenHash: sha256(device.token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect((await logout(device)).status).toBe(401);
    }, 30_000);
  });
});
