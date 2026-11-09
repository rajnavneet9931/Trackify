import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { encodeWorkspaceCursor } from '../src/modules/workspaces/workspace-cursor.js';
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

async function setup(workspaceRepository?: typeof unreachableWorkspaceRepository) {
  const users = new InMemoryUserRepository();
  const workspaces = new InMemoryWorkspaceRepository();
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: new InMemorySessionRepository(users),
    workspaceRepository: workspaceRepository ?? workspaces,
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
  return { app, workspaces, signUp };
}

describe('GET /api/v1/workspaces', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let alice: Account;
  const list = (account: Account, query = '') =>
    request(ctx.app).get(`${URL}${query}`).set('Cookie', account.cookie);
  const create = (account: Account, name: string) =>
    request(ctx.app)
      .post(URL)
      .set('Cookie', account.cookie)
      .set('X-CSRF-Token', account.csrfToken)
      .send({ name });

  beforeEach(async () => {
    ctx = await setup();
    alice = await ctx.signUp('alice@example.com');
  });

  it('returns an empty list for a user without workspaces', async () => {
    const res = await list(alice);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { workspaces: [] }, meta: { limit: 20, nextCursor: null } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('lists the user’s workspaces, newest first, with only public fields and the role', async () => {
    await create(alice, 'First');
    await create(alice, 'Second');

    const res = await list(alice);

    expect(res.status).toBe(200);
    expect(res.body.data.workspaces).toEqual([
      { id: expect.any(String), name: 'Second', createdAt: expect.any(String), role: 'OWNER' },
      { id: expect.any(String), name: 'First', createdAt: expect.any(String), role: 'OWNER' },
    ]);
    expect(res.body.meta.nextCursor).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/userId|membershipId|email|password|token/i);
  });

  it('includes workspaces where the user is a MEMBER, with that role', async () => {
    const bob = await ctx.signUp('bob@example.com');
    const bobsId = (await create(bob, 'Bob Co')).body.data.workspace.id;
    ctx.workspaces.addMember(bobsId, alice.userId);

    const res = await list(alice);

    expect(res.body.data.workspaces).toEqual([
      expect.objectContaining({ id: bobsId, name: 'Bob Co', role: 'MEMBER' }),
    ]);
  });

  it('never shows another user’s workspaces', async () => {
    const bob = await ctx.signUp('bob@example.com');
    await create(bob, 'Bob Secret');
    await create(alice, 'Alice Co');

    const aliceView = (await list(alice)).body.data.workspaces.map((w: { name: string }) => w.name);
    const bobView = (await list(bob)).body.data.workspaces.map((w: { name: string }) => w.name);

    expect(aliceView).toEqual(['Alice Co']);
    expect(bobView).toEqual(['Bob Secret']);
  });

  describe('pagination', () => {
    beforeEach(async () => {
      for (const name of ['W1', 'W2', 'W3', 'W4', 'W5']) await create(alice, name);
    });

    it('walks every page exactly once in a stable order', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await list(alice, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        expect(res.body.meta.limit).toBe(2);
        seen.push(...res.body.data.workspaces.map((w: { name: string }) => w.name));
        cursor = res.body.meta.nextCursor;
        pages++;
      } while (cursor);

      expect(seen).toEqual(['W5', 'W4', 'W3', 'W2', 'W1']);
      expect(pages).toBe(3);
    });

    it('reports no next page when the last page is exactly full', async () => {
      const first = await list(alice, '?limit=5');
      expect(first.body.data.workspaces).toHaveLength(5);
      expect(first.body.meta.nextCursor).toBeNull();
    });

    it('accepts limit boundaries 1 and 100', async () => {
      expect((await list(alice, '?limit=1')).body.data.workspaces).toHaveLength(1);
      expect((await list(alice, '?limit=100')).body.data.workspaces).toHaveLength(5);
    });

    it('returns an empty page (not an error) after the last item', async () => {
      const page = await list(alice, '?limit=5');
      const lastMembership = ctx.workspaces.members.filter((m) => m.userId === alice.userId)[0]!;
      const res = await list(alice, `?cursor=${encodeWorkspaceCursor(lastMembership.id)}`);

      expect(page.status).toBe(200);
      expect(res.body.data.workspaces).toEqual([]);
      expect(res.body.meta.nextCursor).toBeNull();
    });

    it('cannot use another user’s cursor to see their workspaces', async () => {
      const bob = await ctx.signUp('bob@example.com');
      await create(bob, 'Bob A');
      await create(bob, 'Bob B');
      const bobsCursor = (await list(bob, '?limit=1')).body.meta.nextCursor;

      const res = await list(alice, `?cursor=${bobsCursor}`);

      expect(res.status).toBe(200);
      expect(res.body.data.workspaces.every((w: { name: string }) => w.name.startsWith('W'))).toBe(
        true,
      );
    });
  });

  describe('validation', () => {
    it.each([
      ['limit=0', 'limit'],
      ['limit=101', 'limit'],
      ['limit=abc', 'limit'],
      ['limit=2.5', 'limit'],
      ['limit=1&limit=2', 'limit'],
      ['cursor=', 'cursor'],
      [`cursor=${'x'.repeat(201)}`, 'cursor'],
      ['page=2', ''],
      ['userId=00000000-0000-7000-8000-000000000001', ''],
    ])('rejects ?%s with 400', async (query, path) => {
      const res = await list(alice, `?${query}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toContainEqual(
        expect.objectContaining({ location: 'query', path }),
      );
    });

    it.each([
      ['garbage', 'not-a-cursor!'],
      [
        'wrong version',
        Buffer.from('x9:01a14e7b-cea3-700d-aeda-085cd44166ed').toString('base64url'),
      ],
      ['not a uuid', Buffer.from('m1:1 OR 1=1').toString('base64url')],
    ])('rejects a %s cursor with 400 without leaking internals', async (_label, cursor) => {
      const res = await list(alice, `?cursor=${encodeURIComponent(cursor)}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid pagination cursor',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/membership|uuid|prisma|sql/i);
    });
  });

  describe('authentication', () => {
    it('rejects a missing session with 401 (before validating the query)', async () => {
      const res = await request(ctx.app).get(`${URL}?limit=999`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects an invalid session with 401', async () => {
      const res = await request(ctx.app)
        .get(URL)
        .set('Cookie', `trackify_session=${'a'.repeat(43)}`);
      expect(res.status).toBe(401);
    });

    it('needs no CSRF token (read-only) and is unaffected by a foreign Origin', async () => {
      await create(alice, 'Team');
      const res = await list(alice).set('Origin', 'https://evil.example');

      expect(res.status).toBe(200);
      // The browser still cannot read it cross-origin: no CORS grant for that origin.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    const failing = await setup(unreachableWorkspaceRepository);
    const account = await failing.signUp('carol@example.com');

    const res = await request(failing.app).get(URL).set('Cookie', account.cookie);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001/);
  });
});
