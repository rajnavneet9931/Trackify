import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  InMemorySessionRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableWorkspaceRepository,
} from './helpers.js';

const URL = '/api/v1/workspaces';
const PASSWORD = 'correct horse battery staple';

interface Account {
  userId: string;
  cookie: string;
  csrfToken: string;
}

async function setup(
  options: {
    workspaceRepository?: InMemoryWorkspaceRepository | typeof unreachableWorkspaceRepository;
  } = {},
) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const workspaces = new InMemoryWorkspaceRepository();
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: options.workspaceRepository ?? workspaces,
  });

  const signUp = async (email: string): Promise<Account> => {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return {
      userId: registered.body.data.user.id,
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: login.body.data.csrfToken,
    };
  };
  return { app, workspaces, sessions, signUp };
}

describe('POST /api/v1/workspaces', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let alice: Account;
  const create = (account: Account, body: unknown) =>
    request(ctx.app)
      .post(URL)
      .set('Cookie', account.cookie)
      .set('X-CSRF-Token', account.csrfToken)
      .send(body as object);

  beforeEach(async () => {
    ctx = await setup();
    alice = await ctx.signUp('alice@example.com');
  });

  describe('success', () => {
    it('creates the workspace and returns 201 with a minimal representation', async () => {
      const res = await create(alice, { name: '  Platform Team ' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        data: {
          workspace: {
            id: expect.any(String),
            name: 'Platform Team',
            createdAt: expect.any(String),
          },
          membership: { role: 'OWNER' },
        },
      });
    });

    it('makes the session user the OWNER', async () => {
      const res = await create(alice, { name: 'Team' });

      expect(ctx.workspaces.members).toEqual([
        expect.objectContaining({
          workspaceId: res.body.data.workspace.id,
          userId: alice.userId,
          role: 'OWNER',
        }),
      ]);
    });

    it('keeps two users’ workspaces and memberships separate', async () => {
      const bob = await ctx.signUp('bob@example.com');
      const a = (await create(alice, { name: 'Alice Co' })).body.data.workspace.id;
      const b = (await create(bob, { name: 'Bob Co' })).body.data.workspace.id;

      expect(a).not.toBe(b);
      expect(ctx.workspaces.members.map((m) => [m.workspaceId, m.userId])).toEqual([
        [a, alice.userId],
        [b, bob.userId],
      ]);
    });
  });

  describe('authentication', () => {
    it('rejects a missing session with 401 before validating anything', async () => {
      const res = await request(ctx.app).post(URL).send({ role: 'OWNER' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(ctx.workspaces.workspaces).toHaveLength(0);
    });

    it('rejects an invalid session with 401', async () => {
      const res = await create(
        { ...alice, cookie: `trackify_session=${'a'.repeat(43)}` },
        { name: 'Team' },
      );

      expect(res.status).toBe(401);
      expect(ctx.workspaces.workspaces).toHaveLength(0);
    });

    it('rejects a revoked session with 401', async () => {
      ctx.sessions.rows.length = 0;
      expect((await create(alice, { name: 'Team' })).status).toBe(401);
    });

    it('does not reveal anything about workspaces to unauthenticated callers', async () => {
      await create(alice, { name: 'Secret Project' });

      for (const res of [
        await request(ctx.app).post(URL).send({ name: 'x' }),
        await request(ctx.app).get(URL),
        await request(ctx.app).get(`${URL}/${ctx.workspaces.workspaces[0]!.id}`),
      ]) {
        expect(res.status).toBe(401);
        expect(JSON.stringify(res.body)).not.toContain('Secret');
      }
    });
  });

  describe('CSRF and origin', () => {
    it.each([
      ['missing', undefined],
      ['wrong', 'x'.repeat(43)],
    ])('rejects a %s CSRF token with 403 and creates nothing', async (_label, token) => {
      const req = request(ctx.app).post(URL).set('Cookie', alice.cookie);
      const res = await (token ? req.set('X-CSRF-Token', token) : req).send({ name: 'Team' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Invalid or missing CSRF token');
      expect(ctx.workspaces.workspaces).toHaveLength(0);
    });

    it('rejects another user’s CSRF token', async () => {
      const bob = await ctx.signUp('bob@example.com');
      const res = await create({ ...alice, csrfToken: bob.csrfToken }, { name: 'Team' });
      expect(res.status).toBe(403);
    });

    it('rejects a disallowed Origin and cross-site requests', async () => {
      const evil = await create(alice, { name: 'Team' }).set('Origin', 'https://evil.example');
      const crossSite = await create(alice, { name: 'Team' }).set('Sec-Fetch-Site', 'cross-site');

      expect(evil.status).toBe(403);
      expect(crossSite.status).toBe(403);
      expect(ctx.workspaces.workspaces).toHaveLength(0);
    });

    it('accepts the configured frontend origin', async () => {
      const res = await create(alice, { name: 'Team' }).set('Origin', 'http://localhost:5173');
      expect(res.status).toBe(201);
    });
  });

  describe('validation', () => {
    it.each([
      ['missing name', {}],
      ['empty name', { name: '' }],
      ['whitespace name', { name: '    ' }],
      ['too long', { name: 'x'.repeat(101) }],
      ['control characters', { name: 'a\u0007b' }],
      ['non-string', { name: ['Team'] }],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await create(alice, body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(ctx.workspaces.workspaces).toHaveLength(0);
    });

    it.each([
      ['ownerId', { ownerId: '00000000-0000-7000-8000-000000000000' }],
      ['userId', { userId: '00000000-0000-7000-8000-000000000000' }],
      ['role', { role: 'OWNER' }],
      ['members', { members: [{ userId: 'x', role: 'OWNER' }] }],
    ])('rejects client-supplied %s (no ownership injection)', async (field, extra) => {
      const res = await create(alice, { name: 'Team', ...extra });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.details)).toContain(field);
      expect(ctx.workspaces.workspaces).toHaveLength(0);
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await create(alice, 'name=Team').type('form');
      expect(res.status).toBe(415);
    });
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    const failing = await setup({ workspaceRepository: unreachableWorkspaceRepository });
    const account = await failing.signUp('carol@example.com');

    const res = await request(failing.app)
      .post(URL)
      .set('Cookie', account.cookie)
      .set('X-CSRF-Token', account.csrfToken)
      .send({ name: 'Team' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001/);
  });
});
