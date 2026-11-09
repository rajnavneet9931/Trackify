import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  InMemoryAccountRepository,
  InMemoryActivityRepository,
  InMemoryNotificationRepository,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

function setup(failing = false) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const workspaces = new InMemoryWorkspaceRepository(users);
  const projects = new InMemoryProjectRepository(workspaces, users);
  const activities = new InMemoryActivityRepository(workspaces, users);
  const tasks = new InMemoryTaskRepository(projects, workspaces, users, activities);
  const notifications = new InMemoryNotificationRepository(workspaces, users, tasks, projects);
  const accounts = new InMemoryAccountRepository(users, sessions, notifications);
  workspaces.nameOf = (id) => accounts.names.get(id) ?? null;
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
    projectRepository: projects,
    taskRepository: tasks,
    activityRepository: activities,
    notificationRepository: notifications,
    accountRepository: accounts,
  });
  const signUp = async (email: string): Promise<Account> => {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return {
      id: registered.body.data.user.id,
      email,
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: login.body.data.csrfToken,
    };
  };
  return { app, workspaces, projects, notifications, accounts, signUp };
}

describe('workspace settings and deletion', () => {
  let ctx: ReturnType<typeof setup>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;
  let otherWs: string;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const settings = (who: Account, id = ws) =>
    request(ctx.app).get(`/api/v1/workspaces/${id}/settings`).set('Cookie', who.cookie);
  const update = (who: Account, body: object, id = ws) =>
    authed(request(ctx.app).patch(`/api/v1/workspaces/${id}/settings`), who).send(body);
  const remove = (who: Account, id = ws) =>
    authed(request(ctx.app).delete(`/api/v1/workspaces/${id}`), who);
  const version = async (id = ws) =>
    (await settings(owner, id)).body.data.settings.updatedAt as string;

  beforeEach(async () => {
    ctx = setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    const create = async (who: Account, name: string) =>
      (await authed(request(ctx.app).post('/api/v1/workspaces'), who).send({ name })).body.data
        .workspace.id as string;
    ws = await create(owner, 'Team');
    otherWs = await create(outsider, 'Elsewhere');
    ctx.workspaces.addMember(ws, member.id);
  });

  it('requires a session on every endpoint', async () => {
    const calls = [
      request(ctx.app).get(`/api/v1/workspaces/${ws}/settings`),
      request(ctx.app).patch(`/api/v1/workspaces/${ws}/settings`).send({ name: 'X' }),
      request(ctx.app).delete(`/api/v1/workspaces/${ws}`),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
  });

  describe('GET settings', () => {
    it.each([
      ['an owner', () => owner, 'OWNER'],
      ['a member', () => member, 'MEMBER'],
    ])('lets %s read them, with their role', async (_l, who, role) => {
      const res = await settings(who());
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data).toEqual({
        settings: {
          id: ws,
          name: 'Team',
          description: null,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        membership: { role },
      });
    });

    it('answers outsiders like an unknown workspace (404) and validates the id', async () => {
      const foreign = await settings(outsider);
      const unknown = await settings(outsider, UNKNOWN);
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.body.error.message).toBe(unknown.body.error.message);
      expect((await settings(owner, 'nope')).status).toBe(400);
    });
  });

  describe('PATCH settings', () => {
    it('lets an owner change the name and description (normalized)', async () => {
      const res = await update(owner, {
        name: '  Product Team ',
        description: '  Ship it.\nTogether. ',
        expectedUpdatedAt: await version(),
      });
      expect(res.status).toBe(200);
      expect(res.body.data.settings).toMatchObject({
        name: 'Product Team',
        description: 'Ship it.\nTogether.',
      });
      // Visible to members, and in the workspace itself.
      expect((await settings(member)).body.data.settings.name).toBe('Product Team');
      const detail = await request(ctx.app)
        .get(`/api/v1/workspaces/${ws}`)
        .set('Cookie', member.cookie);
      expect(detail.body.data.workspace.name).toBe('Product Team');

      const cleared = await update(owner, {
        description: '  ',
        expectedUpdatedAt: await version(),
      });
      expect(cleared.body.data.settings.description).toBeNull();
    });

    it('refuses members (403) and outsiders (404), changing nothing', async () => {
      const expectedUpdatedAt = await version();
      expect((await update(member, { name: 'Mine', expectedUpdatedAt })).status).toBe(403);
      expect((await update(outsider, { name: 'Mine', expectedUpdatedAt })).status).toBe(404);
      expect((await update(owner, { name: 'Mine', expectedUpdatedAt }, otherWs)).status).toBe(404);
      expect((await settings(owner)).body.data.settings.name).toBe('Team');
    });

    it('rejects a stale version (409) so no edit is silently overwritten', async () => {
      const seen = await version();
      expect((await update(owner, { name: 'First', expectedUpdatedAt: seen })).status).toBe(200);
      const stale = await update(owner, { name: 'Second', expectedUpdatedAt: seen });
      expect(stale.status).toBe(409);
      expect((await settings(owner)).body.data.settings.name).toBe('First');
    });

    it.each([
      [{ name: '' }],
      [{ name: 'x'.repeat(101) }],
      [{ name: 'Tab\there' }],
      [{ description: 'x'.repeat(2001) }],
      [{ description: 'bell\u0007' }],
      [{}],
      [{ name: 'Ok', role: 'OWNER' }],
      [{ name: 'Ok', id: UNKNOWN }],
    ])('rejects %j (400)', async (body) => {
      const res = await update(owner, { ...body, expectedUpdatedAt: await version() });
      expect(res.status).toBe(400);
    });

    it('requires expectedUpdatedAt and the CSRF token', async () => {
      expect((await update(owner, { name: 'X' })).status).toBe(400);
      const noCsrf = await request(ctx.app)
        .patch(`/api/v1/workspaces/${ws}/settings`)
        .set('Cookie', owner.cookie)
        .send({ name: 'X', expectedUpdatedAt: await version() });
      expect(noCsrf.status).toBe(403);
    });
  });

  describe('members', () => {
    it('lists names and emails with roles and join dates', async () => {
      await authed(request(ctx.app).patch('/api/v1/users/me'), member).send({ name: 'Mia' });
      const res = await request(ctx.app)
        .get(`/api/v1/workspaces/${ws}/members`)
        .set('Cookie', member.cookie);
      expect(res.body.data.members).toEqual([
        {
          userId: owner.id,
          name: null,
          email: 'owner@example.com',
          role: 'OWNER',
          joinedAt: expect.any(String),
        },
        {
          userId: member.id,
          name: 'Mia',
          email: 'member@example.com',
          role: 'MEMBER',
          joinedAt: expect.any(String),
        },
      ]);
    });

    it('paginates with a cursor', async () => {
      const first = await request(ctx.app)
        .get(`/api/v1/workspaces/${ws}/members?limit=1`)
        .set('Cookie', owner.cookie);
      expect(first.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([owner.id]);
      const second = await request(ctx.app)
        .get(`/api/v1/workspaces/${ws}/members?limit=1&cursor=${first.body.meta.nextCursor}`)
        .set('Cookie', owner.cookie);
      expect(second.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([
        member.id,
      ]);
      expect(second.body.meta.nextCursor).toBeNull();
    });
  });

  describe('DELETE workspace', () => {
    it('refuses members (403), outsiders and another owner’s workspace (404)', async () => {
      expect((await remove(member)).status).toBe(403);
      expect((await remove(outsider)).status).toBe(404);
      expect((await remove(owner, otherWs)).status).toBe(404);
      expect((await remove(owner, UNKNOWN)).status).toBe(404);
      expect((await settings(owner)).status).toBe(200);
      expect((await settings(outsider, otherWs)).status).toBe(200);
    });

    it('rejects any input besides the URL, and requires the CSRF token', async () => {
      expect((await remove(owner).send({ confirm: true })).status).toBe(400);
      expect(
        (await authed(request(ctx.app).delete(`/api/v1/workspaces/${ws}?force=1`), owner)).status,
      ).toBe(400);
      const noCsrf = await request(ctx.app)
        .delete(`/api/v1/workspaces/${ws}`)
        .set('Cookie', owner.cookie);
      expect(noCsrf.status).toBe(403);
      expect((await settings(owner)).status).toBe(200);
    });

    it('lets an owner delete it: gone for everyone, other workspaces untouched', async () => {
      await authed(request(ctx.app).post(`/api/v1/workspaces/${ws}/projects`), owner).send({
        name: 'Doomed',
      });
      await authed(request(ctx.app).post(`/api/v1/workspaces/${otherWs}/projects`), outsider).send({
        name: 'Safe',
      });

      const res = await remove(owner);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ deleted: true });

      for (const who of [owner, member]) {
        expect((await settings(who)).status).toBe(404);
        const list = await request(ctx.app).get('/api/v1/workspaces').set('Cookie', who.cookie);
        expect(list.body.data.workspaces).toEqual([]);
      }
      expect(ctx.workspaces.members.some((m) => m.workspaceId === ws)).toBe(false);
      expect(ctx.projects.rows.map((p) => p.name)).toEqual(['Safe']);
      expect((await remove(owner)).status).toBe(404); // repeat
      // Accounts and sessions are untouched.
      expect(
        (await request(ctx.app).get('/api/v1/auth/me').set('Cookie', member.cookie)).status,
      ).toBe(200);
    });

    it('lets any of several owners delete it', async () => {
      const coOwner = await ctx.signUp('co@example.com');
      ctx.workspaces.addMember(ws, coOwner.id, 'OWNER');
      expect((await remove(coOwner)).status).toBe(200);
    });

    it('serves an unavailable database as a generic 503', async () => {
      ctx = setup(true);
      const user = await ctx.signUp('n@example.com');
      const res = await remove(user, UNKNOWN);
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|connection|sql/i);
    });
  });
});
