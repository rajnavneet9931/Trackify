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

const PASSWORD = 'correct horse battery staple';
const UNKNOWN_ID = '01a14e7b-cea3-700d-aeda-0000000000ff';

interface Account {
  userId: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

async function setup(failing?: typeof unreachableWorkspaceRepository) {
  const users = new InMemoryUserRepository();
  const workspaces = new InMemoryWorkspaceRepository(users);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: new InMemorySessionRepository(users),
    workspaceRepository: failing ?? workspaces,
  });
  const signUp = async (email: string): Promise<Account> => {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return {
      userId: registered.body.data.user.id,
      email,
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: login.body.data.csrfToken,
    };
  };
  const createWorkspace = async (owner: Account, name: string): Promise<string> =>
    (
      await request(app)
        .post('/api/v1/workspaces')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Token', owner.csrfToken)
        .send({ name })
    ).body.data.workspace.id;
  return { app, users, workspaces, signUp, createWorkspace };
}

describe('workspace details and members', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let workspaceId: string;
  const get = (account: Account, path: string) =>
    request(ctx.app).get(`/api/v1/workspaces${path}`).set('Cookie', account.cookie);

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    workspaceId = await ctx.createWorkspace(owner, 'Platform Team');
    ctx.workspaces.addMember(workspaceId, member.userId);
    await ctx.createWorkspace(outsider, 'Outsider Co');
  });

  describe('GET /workspaces/:workspaceId', () => {
    it('returns the workspace and the caller’s role (owner)', async () => {
      const res = await get(owner, `/${workspaceId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          workspace: { id: workspaceId, name: 'Platform Team', createdAt: expect.any(String) },
          membership: { role: 'OWNER' },
        },
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns MEMBER for a member, with no other users’ information', async () => {
      const res = await get(member, `/${workspaceId}`);

      expect(res.body.data.membership).toEqual({ role: 'MEMBER' });
      expect(JSON.stringify(res.body)).not.toMatch(/owner@example\.com|userId|email/);
    });

    it('accepts an upper-case UUID', async () => {
      expect((await get(owner, `/${workspaceId.toUpperCase()}`)).status).toBe(200);
    });

    it('gives the same 404 to a non-member and for a nonexistent workspace', async () => {
      const notMember = await get(outsider, `/${workspaceId}`);
      const missing = await get(outsider, `/${UNKNOWN_ID}`);

      for (const res of [notMember, missing]) {
        expect(res.status).toBe(404);
        expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      expect(JSON.stringify(notMember.body)).not.toContain('Platform');
    });

    it.each(['not-a-uuid', '123', '01a14e7b-cea3-700d-aeda-085cd44166edX'])(
      'rejects invalid id %s with 400',
      async (id) => {
        const res = await get(owner, `/${id}`);
        expect(res.status).toBe(400);
        expect(res.body.error.details).toContainEqual(
          expect.objectContaining({ location: 'params', path: 'workspaceId' }),
        );
      },
    );

    it('requires a session (401 before validation)', async () => {
      const res = await request(ctx.app).get('/api/v1/workspaces/not-a-uuid');
      expect(res.status).toBe(401);
    });

    it('returns 503 when the database is unavailable', async () => {
      const failing = await setup(unreachableWorkspaceRepository);
      const account = await failing.signUp('carol@example.com');
      const res = await request(failing.app)
        .get(`/api/v1/workspaces/${UNKNOWN_ID}`)
        .set('Cookie', account.cookie);

      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001/);
    });
  });

  describe('GET /workspaces/:workspaceId/members', () => {
    it('lists members oldest first with only the agreed fields', async () => {
      const res = await get(owner, `/${workspaceId}/members`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          members: [
            {
              userId: owner.userId,
              name: null,
              email: 'owner@example.com',
              role: 'OWNER',
              joinedAt: expect.any(String),
            },
            {
              userId: member.userId,
              name: null,
              email: 'member@example.com',
              role: 'MEMBER',
              joinedAt: expect.any(String),
            },
          ],
        },
        meta: { limit: 20, nextCursor: null },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session|token|argon/i);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('is visible to members too, not only the owner', async () => {
      const res = await get(member, `/${workspaceId}/members`);
      expect(res.body.data.members.map((m: { email: string }) => m.email)).toEqual([
        'owner@example.com',
        'member@example.com',
      ]);
    });

    it('never includes users from other workspaces', async () => {
      const res = await get(owner, `/${workspaceId}/members`);
      expect(JSON.stringify(res.body)).not.toContain('outsider@example.com');
    });

    it('gives the same 404 to non-members and for nonexistent workspaces', async () => {
      for (const res of [
        await get(outsider, `/${workspaceId}/members`),
        await get(outsider, `/${UNKNOWN_ID}/members`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Workspace not found');
        expect(JSON.stringify(res.body)).not.toContain('@example.com');
      }
    });

    it('authorizes before validating the cursor (no information for non-members)', async () => {
      const res = await get(outsider, `/${workspaceId}/members?cursor=garbage`);
      expect(res.status).toBe(404);
    });

    describe('pagination', () => {
      beforeEach(async () => {
        for (const n of [1, 2, 3]) {
          const extra = await ctx.signUp(`extra${n}@example.com`);
          ctx.workspaces.addMember(workspaceId, extra.userId);
        }
      });

      it('walks all members exactly once in join order', async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const res = await get(
            owner,
            `/${workspaceId}/members?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          );
          expect(res.status).toBe(200);
          seen.push(...res.body.data.members.map((m: { email: string }) => m.email));
          cursor = res.body.meta.nextCursor;
          pages++;
        } while (cursor && pages < 10);

        expect(seen).toEqual([
          'owner@example.com',
          'member@example.com',
          'extra1@example.com',
          'extra2@example.com',
          'extra3@example.com',
        ]);
        expect(pages).toBe(3);
      });

      it('reports no next page when the last page is exactly full', async () => {
        const res = await get(owner, `/${workspaceId}/members?limit=5`);
        expect(res.body.data.members).toHaveLength(5);
        expect(res.body.meta.nextCursor).toBeNull();
      });

      it.each([
        ['limit=0', 400],
        ['limit=101', 400],
        ['limit=abc', 400],
        ['role=OWNER', 400],
        ['cursor=garbage!', 400],
      ])('rejects ?%s', async (query, status) => {
        expect((await get(owner, `/${workspaceId}/members?${query}`)).status).toBe(status);
      });

      it('rejects a cursor taken from the workspace list', async () => {
        const res = await get(
          owner,
          `/${workspaceId}/members?cursor=${encodeWorkspaceCursor(UNKNOWN_ID)}`,
        );
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('Invalid pagination cursor');
      });
    });

    it('returns 503 when the database is unavailable', async () => {
      const failing = await setup(unreachableWorkspaceRepository);
      const account = await failing.signUp('carol@example.com');
      const res = await request(failing.app)
        .get(`/api/v1/workspaces/${UNKNOWN_ID}/members`)
        .set('Cookie', account.cookie);

      expect(res.status).toBe(503);
    });
  });
});
