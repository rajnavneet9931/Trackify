import { Writable } from 'node:stream';

import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  buildTestApp,
  InMemoryUserRepository,
  unreachableUserRepository as unreachableDatabase,
} from './helpers.js';

const URL = '/api/v1/auth/register';
const PASSWORD = 'correct horse battery staple';

describe('POST /api/v1/auth/register', () => {
  describe('success', () => {
    it('creates the user and returns 201 with a minimal representation', async () => {
      const users = new InMemoryUserRepository();
      const res = await request(buildTestApp({ userRepository: users }))
        .post(URL)
        .send({ email: 'ada@example.com', password: PASSWORD });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        data: {
          user: { id: expect.any(String), email: 'ada@example.com', createdAt: expect.any(String) },
        },
      });
      expect(new Date(res.body.data.user.createdAt).toISOString()).toBe(
        res.body.data.user.createdAt,
      );
      expect(users.rows).toHaveLength(1);
    });

    it('normalizes the email before storing and returning it', async () => {
      const users = new InMemoryUserRepository();
      const res = await request(buildTestApp({ userRepository: users }))
        .post(URL)
        .send({ email: '  Ada.Lovelace@EXAMPLE.com ', password: PASSWORD });

      expect(res.body.data.user.email).toBe('ada.lovelace@example.com');
      expect(users.rows[0]?.email).toBe('ada.lovelace@example.com');
    });

    it('stores an Argon2id hash and never returns the password or hash', async () => {
      const users = new InMemoryUserRepository();
      const res = await request(buildTestApp({ userRepository: users }))
        .post(URL)
        .send({ email: 'ada@example.com', password: PASSWORD });

      expect(users.rows[0]?.passwordHash).toMatch(/^\$argon2id\$/);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain('$argon2');
      expect(body).not.toMatch(/password/i);
    });

    it('issues no session or token', async () => {
      const res = await request(buildTestApp())
        .post(URL)
        .send({ email: 'ada@example.com', password: PASSWORD });

      expect(res.headers['set-cookie']).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    });
  });

  describe('validation', () => {
    it.each([
      ['invalid email', { email: 'nope', password: PASSWORD }, 'email'],
      ['short password', { email: 'ada@example.com', password: 'short' }, 'password'],
      ['long password', { email: 'ada@example.com', password: 'x'.repeat(129) }, 'password'],
      ['missing email', { password: PASSWORD }, 'email'],
      ['missing password', { email: 'ada@example.com' }, 'password'],
    ])('rejects %s with 400', async (_label, body, field) => {
      const users = new InMemoryUserRepository();
      const res = await request(buildTestApp({ userRepository: users }))
        .post(URL)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toContainEqual(
        expect.objectContaining({ location: 'body', path: field }),
      );
      expect(users.rows).toHaveLength(0);
    });

    it('rejects unexpected fields such as role (mass assignment)', async () => {
      const users = new InMemoryUserRepository();
      const res = await request(buildTestApp({ userRepository: users }))
        .post(URL)
        .send({ email: 'ada@example.com', password: PASSWORD, role: 'admin', isAdmin: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body.error.details)).toMatch(/role/);
      expect(users.rows).toHaveLength(0);
    });

    it('rejects an empty body', async () => {
      const res = await request(buildTestApp()).post(URL).set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await request(buildTestApp())
        .post(URL)
        .type('form')
        .send({ email: 'ada@example.com', password: PASSWORD });

      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('does not echo submitted values in validation errors', async () => {
      const res = await request(buildTestApp())
        .post(URL)
        .send({ email: 'ada@example.com', password: 'tiny-secret' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('tiny-secret');
    });
  });

  describe('duplicates', () => {
    it('returns 409 for an email that is already registered, regardless of case', async () => {
      const app = buildTestApp();
      await request(app).post(URL).send({ email: 'ada@example.com', password: PASSWORD });

      const res = await request(app)
        .post(URL)
        .send({ email: ' ADA@Example.com', password: 'a different passphrase' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'An account with this email address already exists',
      });
    });
  });

  describe('failures', () => {
    it('returns a generic 503 when the database is unavailable', async () => {
      const res = await request(buildTestApp({ userRepository: unreachableDatabase }))
        .post(URL)
        .send({ email: 'ada@example.com', password: PASSWORD });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      const body = JSON.stringify(res.body);
      for (const leak of ['secret-host', 'prisma', 'P1001', PASSWORD]) {
        expect(body).not.toContain(leak);
      }
    });

    it('returns a generic 500 for unexpected errors', async () => {
      const res = await request(
        buildTestApp({
          userRepository: {
            create: () => Promise.reject(new Error('relation "users" ...')),
            findCredentialsByEmail: () => Promise.resolve(null),
          },
        }),
      )
        .post(URL)
        .send({ email: 'ada@example.com', password: PASSWORD });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      });
      expect(JSON.stringify(res.body)).not.toContain('relation');
    });

    it('never writes the password or its hash to the logs', async () => {
      let logs = '';
      const sink = new Writable({
        write(chunk, _encoding, done) {
          logs += chunk.toString();
          done();
        },
      });
      const users = new InMemoryUserRepository();
      const app = buildTestApp({ userRepository: users, logger: pino({ level: 'trace' }, sink) });

      await request(app).post(URL).send({ email: 'ada@example.com', password: PASSWORD });
      await request(app).post(URL).send({ email: 'ada@example.com', password: PASSWORD });
      await request(app).post(URL).send({ email: 'bad', password: 'tiny-secret' });
      await request(
        buildTestApp({
          userRepository: unreachableDatabase,
          logger: pino({ level: 'trace' }, sink),
        }),
      )
        .post(URL)
        .send({ email: 'ada@example.com', password: PASSWORD });

      expect(logs.length).toBeGreaterThan(0);
      expect(logs).not.toContain(PASSWORD);
      expect(logs).not.toContain('tiny-secret');
      expect(logs).not.toContain(users.rows[0]!.passwordHash);
    });
  });

  describe('security', () => {
    it('rate-limits registration attempts per IP, including invalid ones', async () => {
      const app = buildTestApp({ env: { REGISTER_RATE_LIMIT_MAX: '3' } });

      const statuses = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (
            await request(app)
              .post(URL)
              .send({ email: `u${i}@example.com`, password: 'short' })
          ).status,
        );
      }
      const limited = await request(app)
        .post(URL)
        .send({ email: 'late@example.com', password: PASSWORD });

      expect(statuses).toEqual([400, 400, 400, 429]);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(limited.headers['ratelimit-policy']).toBeDefined();
    });

    it('applies the standard security headers and CORS policy', async () => {
      const res = await request(buildTestApp())
        .post(URL)
        .set('Origin', 'https://evil.example')
        .send({ email: 'ada@example.com', password: PASSWORD });

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('exposes registration only via POST', async () => {
      const app = buildTestApp();
      for (const method of ['get', 'put', 'delete'] as const) {
        expect((await request(app)[method](URL)).status).toBe(404);
      }
    });
  });
});
