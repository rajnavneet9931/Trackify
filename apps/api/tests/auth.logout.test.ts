import { Writable } from 'node:stream';

import type { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { generateSessionToken } from '../src/modules/sessions/session-token.js';
import {
  buildTestApp,
  InMemorySessionRepository,
  InMemoryUserRepository,
  unreachableDatabaseError,
  unreachableSessionRepository,
} from './helpers.js';

const LOGOUT = '/api/v1/auth/logout';
const ME = '/api/v1/auth/me';
const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery staple';

interface Device {
  token: string;
  csrfToken: string;
  cookieName: string;
}

function setCookieHeader(res: request.Response): string | undefined {
  return ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((h) => h.includes('trackify_session='));
}

async function setup(env: NodeJS.ProcessEnv = {}) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const app = buildTestApp({ userRepository: users, sessionRepository: sessions, env });
  await request(app).post('/api/v1/auth/register').send({ email: EMAIL, password: PASSWORD });

  const signIn = async (): Promise<Device> => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    const [pair] = setCookieHeader(res)!.split(';');
    const [cookieName, token] = pair!.split('=') as [string, string];
    return { token, cookieName, csrfToken: res.body.data.csrfToken };
  };
  return { app, users, sessions, signIn };
}

const cookieOf = (device: Device) => `${device.cookieName}=${device.token}`;
const logout = (app: Express, device: Device, csrf: string | null = device.csrfToken) => {
  const req = request(app).post(LOGOUT).set('Cookie', cookieOf(device));
  return csrf === null ? req : req.set('X-CSRF-Token', csrf);
};
const me = (app: Express, device: Device) => request(app).get(ME).set('Cookie', cookieOf(device));

describe('POST /api/v1/auth/logout', () => {
  let app: Express;
  let sessions: InMemorySessionRepository;
  let device: Device;
  let signIn: () => Promise<Device>;

  beforeEach(async () => {
    ({ app, sessions, signIn } = await setup());
    device = await signIn();
  });

  describe('success', () => {
    it('returns 200 with a minimal body and no sensitive data', async () => {
      const res = await logout(app, device);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { loggedOut: true } });
      expect(res.headers['cache-control']).toBe('no-store');
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(device.token);
      expect(body).not.toContain(device.csrfToken);
    });

    it('deletes the server-side session record', async () => {
      expect(sessions.rows).toHaveLength(1);
      await logout(app, device);
      expect(sessions.rows).toHaveLength(0);
    });

    it('clears the cookie with the same name, path and attributes used to set it', async () => {
      const res = await logout(app, device);
      const header = setCookieHeader(res)!;
      const attributes = header.split(';').map((a) => a.trim().toLowerCase());

      expect(header.startsWith('trackify_session=;')).toBe(true);
      expect(attributes).toEqual(
        expect.arrayContaining([
          'path=/api',
          'httponly',
          'samesite=strict',
          'expires=thu, 01 jan 1970 00:00:00 gmt',
        ]),
      );
      expect(attributes.some((a) => a.startsWith('domain='))).toBe(false);
    });

    it('clears the production (__Secure-, Secure) cookie in production configuration', async () => {
      const secure = await setup({ SESSION_COOKIE_SECURE: 'true' });
      const prodDevice = await secure.signIn();
      expect(prodDevice.cookieName).toBe('__Secure-trackify_session');

      const res = await logout(secure.app, prodDevice);
      const header = setCookieHeader(res)!;

      expect(res.status).toBe(200);
      expect(header.startsWith('__Secure-trackify_session=;')).toBe(true);
      expect(header).toMatch(/;\s*Path=\/api/);
      expect(header).toMatch(/;\s*Secure/);
      expect(header).toMatch(/;\s*HttpOnly/);
      expect(header).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('makes the old cookie unusable for any further request', async () => {
      await logout(app, device);

      expect((await me(app, device)).status).toBe(401);
      expect((await logout(app, device)).status).toBe(401);
    });

    it('revokes only this device; other sessions stay valid', async () => {
      const laptop = device;
      const phone = await signIn();

      expect((await logout(app, laptop)).status).toBe(200);

      expect((await me(app, laptop)).status).toBe(401);
      expect((await me(app, phone)).status).toBe(200);
      expect(sessions.rows).toHaveLength(1);
    });
  });

  describe('requires a currently valid session (not idempotent)', () => {
    it('rejects a request without a cookie with 401', async () => {
      const res = await request(app).post(LOGOUT).set('X-CSRF-Token', device.csrfToken);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      expect(sessions.rows).toHaveLength(1);
    });

    it('rejects a malformed cookie without a database lookup, and clears it', async () => {
      sessions.lookups = 0;
      const res = await request(app).post(LOGOUT).set('Cookie', 'trackify_session=garbage');

      expect(res.status).toBe(401);
      expect(sessions.lookups).toBe(0);
      expect(setCookieHeader(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('rejects an expired session with 401 and clears the cookie', async () => {
      sessions.rows[0]!.expiresAt = new Date(Date.now() - 1);
      const res = await logout(app, device);

      expect(res.status).toBe(401);
      expect(setCookieHeader(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('rejects an already revoked session with 401', async () => {
      await logout(app, device);
      const again = await logout(app, device);

      expect(again.status).toBe(401);
      expect(again.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects an unknown well-formed token with 401', async () => {
      const res = await logout(app, { ...device, token: generateSessionToken() });
      expect(res.status).toBe(401);
      expect(sessions.rows).toHaveLength(1);
    });
  });

  describe('CSRF and origin protection', () => {
    it.each([
      ['missing', null],
      ['empty', ''],
      ['forged', 'x'.repeat(43)],
    ])('rejects a %s CSRF token with 403 and keeps the session', async (_label, csrf) => {
      const res = await logout(app, device, csrf);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Invalid or missing CSRF token',
      });
      expect(setCookieHeader(res)).toBeUndefined();
      expect((await me(app, device)).status).toBe(200);
    });

    it('rejects another session’s CSRF token', async () => {
      const other = await signIn();
      const res = await logout(app, device, other.csrfToken);

      expect(res.status).toBe(403);
      expect(sessions.rows).toHaveLength(2);
    });

    it('rejects a disallowed Origin before touching the session', async () => {
      sessions.lookups = 0;
      const res = await logout(app, device).set('Origin', 'https://evil.example');

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Cross-site request rejected');
      expect(sessions.lookups).toBe(0);
      expect((await me(app, device)).status).toBe(200);
    });

    it('rejects cross-site Fetch Metadata', async () => {
      const res = await logout(app, device).set('Sec-Fetch-Site', 'cross-site');

      expect(res.status).toBe(403);
      expect((await me(app, device)).status).toBe(200);
    });

    it('accepts the configured frontend origin', async () => {
      const res = await logout(app, device)
        .set('Origin', 'http://localhost:5173')
        .set('Sec-Fetch-Site', 'same-site');

      expect(res.status).toBe(200);
    });

    it('is POST-only (GET cannot trigger logout)', async () => {
      const res = await request(app).get(LOGOUT).set('Cookie', cookieOf(device));

      expect(res.status).toBe(404);
      expect((await me(app, device)).status).toBe(200);
    });
  });

  describe('database failures', () => {
    it('returns 503 and keeps the session and cookie when deletion fails', async () => {
      sessions.delete = () => Promise.reject(unreachableDatabaseError());

      const res = await logout(app, device);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|loggedOut/);
      expect(setCookieHeader(res)).toBeUndefined();
      expect(sessions.rows).toHaveLength(1);
    });

    it('returns 503 (not 401) when the session cannot be looked up', async () => {
      const res = await request(buildTestApp({ sessionRepository: unreachableSessionRepository }))
        .post(LOGOUT)
        .set('Cookie', cookieOf(device))
        .set('X-CSRF-Token', device.csrfToken);

      expect(res.status).toBe(503);
      expect(setCookieHeader(res)).toBeUndefined();
    });
  });

  it('never logs the session token or CSRF token', async () => {
    let logs = '';
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    });
    const users = new InMemoryUserRepository();
    const sessionRepo = new InMemorySessionRepository(users);
    const logged = buildTestApp({
      userRepository: users,
      sessionRepository: sessionRepo,
      logger: pino({ level: 'trace' }, sink),
    });
    await request(logged).post('/api/v1/auth/register').send({ email: EMAIL, password: PASSWORD });
    const login = await request(logged)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    const token = setCookieHeader(login)!.split(';')[0]!.split('=')[1]!;
    const csrf = login.body.data.csrfToken;

    await request(logged)
      .post(LOGOUT)
      .set('Cookie', `trackify_session=${token}`)
      .set('X-CSRF-Token', 'wrong');
    await request(logged)
      .post(LOGOUT)
      .set('Cookie', `trackify_session=${token}`)
      .set('X-CSRF-Token', csrf);

    expect(logs).toContain('/api/v1/auth/logout');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(csrf);
  });
});
