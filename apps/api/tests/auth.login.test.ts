import { Writable } from 'node:stream';

import express, { type Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { errorHandler } from '../src/core/middleware/error-handler.js';
import { requestLogger } from '../src/core/middleware/request-logger.js';
import { requireSession, SessionService } from '../src/modules/sessions/index.js';
import { generateSessionToken } from '../src/modules/sessions/session-token.js';
import {
  buildTestApp,
  InMemorySessionRepository,
  InMemoryUserRepository,
  unreachableSessionRepository,
  unreachableUserRepository,
} from './helpers.js';

const LOGIN = '/api/v1/auth/login';
const ME = '/api/v1/auth/me';
const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery staple';
const COOKIE = 'trackify_session';

/** Extracts the session token from a Set-Cookie response header. */
function sessionCookie(res: request.Response): { token: string; header: string } | undefined {
  const headers = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const header = headers.find(
    (h) => h.startsWith(`${COOKIE}=`) || h.startsWith(`__Secure-${COOKIE}=`),
  );
  if (!header) return undefined;
  return { token: header.split(';')[0]!.split('=')[1]!, header };
}

const withCookie = (token: string) => `${COOKIE}=${token}`;

async function registeredApp(env: NodeJS.ProcessEnv = {}) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const app = buildTestApp({ userRepository: users, sessionRepository: sessions, env });
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(201);
  return { app, users, sessions };
}

describe('POST /api/v1/auth/login', () => {
  let app: Express;
  let sessions: InMemorySessionRepository;

  beforeEach(async () => {
    ({ app, sessions } = await registeredApp());
  });

  describe('success', () => {
    it('returns the user and a CSRF token, and sets the session cookie', async () => {
      const res = await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          user: { id: expect.any(String), email: EMAIL, createdAt: expect.any(String) },
          csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          expiresAt: expect.any(String),
        },
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(sessionCookie(res)?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(sessions.rows).toHaveLength(1);
    });

    it('normalizes the email exactly like registration', async () => {
      const res = await request(app)
        .post(LOGIN)
        .send({ email: '  ADA@Example.COM ', password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe(EMAIL);
    });

    it('never puts the session token, password or hash in the body', async () => {
      const res = await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });
      const body = JSON.stringify(res.body);

      expect(body).not.toContain(sessionCookie(res)!.token);
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toMatch(/argon2|passwordHash|tokenHash/i);
    });

    it('sets an HttpOnly, SameSite=Strict cookie scoped to /api with a bounded expiry', async () => {
      const res = await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });
      const { header } = sessionCookie(res)!;
      const attributes = header.split(';').map((a) => a.trim().toLowerCase());

      expect(attributes).toContain('httponly');
      expect(attributes).toContain('path=/api');
      expect(attributes).toContain('samesite=strict');
      expect(attributes.some((a) => a.startsWith('domain='))).toBe(false);
      // Development/test config: no Secure flag so the cookie works on http://localhost.
      expect(attributes).not.toContain('secure');

      const maxAge = Number(attributes.find((a) => a.startsWith('max-age='))!.split('=')[1]);
      expect(maxAge).toBeGreaterThan(7 * 24 * 3600 - 5);
      expect(maxAge).toBeLessThanOrEqual(7 * 24 * 3600);
      const expires = new Date(header.match(/Expires=([^;]+)/)![1]!).getTime();
      expect(Math.abs(expires - new Date(res.body.data.expiresAt).getTime())).toBeLessThan(2000);
    });

    it('uses a Secure, __Secure- prefixed cookie when configured for HTTPS', async () => {
      const secure = await registeredApp({ SESSION_COOKIE_SECURE: 'true' });
      const res = await request(secure.app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });
      const { header } = sessionCookie(res)!;

      expect(header.startsWith(`__Secure-${COOKIE}=`)).toBe(true);
      expect(header).toMatch(/;\s*Secure/i);
      expect(header).toMatch(/;\s*HttpOnly/i);
    });
  });

  describe('invalid credentials', () => {
    it('gives identical responses for an unknown email and a wrong password', async () => {
      const unknown = await request(app)
        .post(LOGIN)
        .send({ email: 'nobody@example.com', password: PASSWORD });
      const wrong = await request(app)
        .post(LOGIN)
        .send({ email: EMAIL, password: 'wrong password here' });

      for (const res of [unknown, wrong]) {
        expect(res.status).toBe(401);
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      const strip = (body: { error: Record<string, unknown> }) => ({
        ...body.error,
        requestId: undefined,
      });
      expect(strip(unknown.body)).toEqual(strip(wrong.body));
      expect(unknown.body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password',
      });
      expect(sessions.rows).toHaveLength(0);
    });

    it('verifies against the stored hash (case-sensitive, untrimmed password)', async () => {
      for (const password of [PASSWORD.toUpperCase(), ` ${PASSWORD}`, `${PASSWORD} `]) {
        expect((await request(app).post(LOGIN).send({ email: EMAIL, password })).status).toBe(401);
      }
    });
  });

  describe('validation', () => {
    it.each([
      ['invalid email', { email: 'nope', password: PASSWORD }],
      ['missing password', { email: EMAIL }],
      ['empty password', { email: EMAIL, password: '' }],
      ['overlong password', { email: EMAIL, password: 'x'.repeat(129) }],
      ['unexpected field', { email: EMAIL, password: PASSWORD, rememberMe: true }],
    ])('rejects %s with 400 and no cookie', async (_label, body) => {
      const res = await request(app).post(LOGIN).send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await request(app)
        .post(LOGIN)
        .type('form')
        .send({ email: EMAIL, password: PASSWORD });
      expect(res.status).toBe(415);
    });
  });

  describe('session rotation and fixation', () => {
    it('issues a new token on every login and revokes the one the client presented', async () => {
      const first = sessionCookie(
        await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD }),
      )!;
      const second = sessionCookie(
        await request(app)
          .post(LOGIN)
          .set('Cookie', withCookie(first.token))
          .send({ email: EMAIL, password: PASSWORD }),
      )!;

      expect(second.token).not.toBe(first.token);
      expect((await request(app).get(ME).set('Cookie', withCookie(first.token))).status).toBe(401);
      expect((await request(app).get(ME).set('Cookie', withCookie(second.token))).status).toBe(200);
      expect(sessions.rows).toHaveLength(1);
    });

    it('never adopts a session ID chosen by the client (fixation)', async () => {
      const planted = generateSessionToken();
      const res = await request(app)
        .post(LOGIN)
        .set('Cookie', withCookie(planted))
        .send({ email: EMAIL, password: PASSWORD });

      expect(sessionCookie(res)!.token).not.toBe(planted);
      expect((await request(app).get(ME).set('Cookie', withCookie(planted))).status).toBe(401);
    });

    it('keeps sessions on other devices when one device logs in again', async () => {
      const deviceA = sessionCookie(
        await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD }),
      )!;
      await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });

      expect((await request(app).get(ME).set('Cookie', withCookie(deviceA.token))).status).toBe(
        200,
      );
      expect(sessions.rows).toHaveLength(2);
    });

    it('removes the user’s expired sessions on login', async () => {
      await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });
      sessions.rows[0]!.expiresAt = new Date(Date.now() - 1000);

      await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });

      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('rate limiting', () => {
    it('limits all login attempts per IP', async () => {
      const limited = (await registeredApp({ LOGIN_RATE_LIMIT_MAX: '3' })).app;
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (await request(limited).post(LOGIN).send({ email: EMAIL, password: PASSWORD })).status,
        );
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it('limits failed attempts per account without counting successes', async () => {
      const limited = (await registeredApp({ LOGIN_ACCOUNT_RATE_LIMIT_MAX: '2' })).app;
      const attempt = (email: string, password: string) =>
        request(limited).post(LOGIN).send({ email, password });

      expect((await attempt(EMAIL, PASSWORD)).status).toBe(200);
      expect((await attempt(EMAIL, 'wrong password 1')).status).toBe(401);
      expect((await attempt(' ADA@example.com', 'wrong password 2')).status).toBe(401);
      // The account is now locked for the window, even with the right password…
      const locked = await attempt(EMAIL, PASSWORD);
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe('RATE_LIMITED');
      // …while other accounts are unaffected.
      expect((await attempt('someone@example.com', 'whatever password')).status).toBe(401);
    });
  });

  describe('database failures', () => {
    it('returns 503 when users cannot be read', async () => {
      const res = await request(buildTestApp({ userRepository: unreachableUserRepository }))
        .post(LOGIN)
        .send({ email: EMAIL, password: PASSWORD });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001/);
    });

    it('returns 503 and sets no cookie when the session cannot be stored', async () => {
      const users = new InMemoryUserRepository();
      const failing = buildTestApp({
        userRepository: users,
        sessionRepository: unreachableSessionRepository,
      });
      await request(failing)
        .post('/api/v1/auth/register')
        .send({ email: EMAIL, password: PASSWORD });

      const res = await request(failing).post(LOGIN).send({ email: EMAIL, password: PASSWORD });

      expect(res.status).toBe(503);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });
});

describe('GET /api/v1/auth/me', () => {
  let app: Express;
  let sessions: InMemorySessionRepository;
  let token: string;
  let csrfToken: string;

  beforeEach(async () => {
    ({ app, sessions } = await registeredApp());
    const res = await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });
    token = sessionCookie(res)!.token;
    csrfToken = res.body.data.csrfToken;
  });

  it('returns only the current user’s public fields and the CSRF token', async () => {
    const res = await request(app).get(ME).set('Cookie', withCookie(token));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        user: { id: expect.any(String), email: EMAIL, createdAt: expect.any(String) },
        csrfToken,
        expiresAt: expect.any(String),
      },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects a missing session with 401', async () => {
    const res = await request(app).get(ME);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a malformed cookie without querying the database, and clears it', async () => {
    sessions.lookups = 0;
    const res = await request(app).get(ME).set('Cookie', withCookie('not-a-real-token'));

    expect(res.status).toBe(401);
    expect(sessions.lookups).toBe(0);
    expect(sessionCookie(res)?.header).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('rejects an unknown (well-formed) token with 401', async () => {
    const res = await request(app).get(ME).set('Cookie', withCookie(generateSessionToken()));
    expect(res.status).toBe(401);
  });

  it('rejects an expired session with 401', async () => {
    sessions.rows[0]!.expiresAt = new Date(Date.now() - 1);
    const res = await request(app).get(ME).set('Cookie', withCookie(token));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a revoked (deleted) session immediately', async () => {
    sessions.rows.length = 0;
    expect((await request(app).get(ME).set('Cookie', withCookie(token))).status).toBe(401);
  });

  it('returns 503, not 401, when sessions cannot be checked', async () => {
    const res = await request(buildTestApp({ sessionRepository: unreachableSessionRepository }))
      .get(ME)
      .set('Cookie', withCookie(token));

    expect(res.status).toBe(503);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('CSRF protection for cookie-authenticated unsafe requests (layer 2)', () => {
  // No state-changing authenticated endpoint exists yet, so mount requireSession
  // on a probe route exactly as future modules will.
  async function protectedApp() {
    const config = loadConfig();
    const users = new InMemoryUserRepository();
    const sessionRepo = new InMemorySessionRepository(users);
    const sessions = new SessionService(sessionRepo, config.auth.session.ttlMs);
    const user = await users.create({ email: EMAIL, passwordHash: 'unused' });

    const app = express();
    app.use(requestLogger(createLogger(config)));
    const guard = requireSession(sessions, config.auth.session.cookie);
    app.post('/api/probe', guard, (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/api/probe', guard, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    return { app, issue: () => sessions.create(user.id) };
  }

  it('requires the session’s CSRF token on POST', async () => {
    const { app, issue } = await protectedApp();
    const session = await issue();
    const other = await issue();
    const post = () => request(app).post('/api/probe').set('Cookie', withCookie(session.token));

    expect((await post()).status).toBe(403);
    expect((await post()).body.error.message).toBe('Invalid or missing CSRF token');
    expect((await post().set('X-CSRF-Token', 'forged')).status).toBe(403);
    expect((await post().set('X-CSRF-Token', other.csrfToken)).status).toBe(403);
    expect((await post().set('X-CSRF-Token', session.csrfToken)).status).toBe(200);
  });

  it('does not require it for safe methods', async () => {
    const { app, issue } = await protectedApp();
    const session = await issue();

    const res = await request(app).get('/api/probe').set('Cookie', withCookie(session.token));
    expect(res.status).toBe(200);
  });

  it('checks authentication before CSRF (no session → 401)', async () => {
    const { app } = await protectedApp();
    expect((await request(app).post('/api/probe').set('X-CSRF-Token', 'x')).status).toBe(401);
  });
});

describe('logging', () => {
  it('never logs passwords, hashes, session tokens, cookies or CSRF tokens', async () => {
    let logs = '';
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    });
    const users = new InMemoryUserRepository();
    const app = buildTestApp({
      userRepository: users,
      sessionRepository: new InMemorySessionRepository(users),
      logger: pino({ level: 'trace' }, sink),
    });

    await request(app).post('/api/v1/auth/register').send({ email: EMAIL, password: PASSWORD });
    const login = await request(app).post(LOGIN).send({ email: EMAIL, password: PASSWORD });
    const { token } = sessionCookie(login)!;
    await request(app).post(LOGIN).send({ email: EMAIL, password: 'a wrong password' });
    await request(app).get(ME).set('Cookie', withCookie(token)).set('X-CSRF-Token', 'abc');
    await request(app).get(ME).set('Cookie', withCookie('garbage-token'));

    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      PASSWORD,
      'a wrong password',
      token,
      login.body.data.csrfToken,
      users.rows[0]!.passwordHash,
    ]) {
      expect(logs).not.toContain(secret);
    }
  });
});
