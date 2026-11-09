import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { canonicalTimeZone } from '../src/modules/account/account.validators.js';
import {
  buildTestApp,
  InMemoryAccountRepository,
  InMemoryActivityRepository,
  InMemoryCommentRepository,
  InMemoryNotificationRepository,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableAccountRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new passphrase';

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

function setup({ failing = false, env = {} }: { failing?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const workspaces = new InMemoryWorkspaceRepository(users);
  const projects = new InMemoryProjectRepository(workspaces, users);
  const activities = new InMemoryActivityRepository(workspaces, users);
  const tasks = new InMemoryTaskRepository(projects, workspaces, users, activities);
  const comments = new InMemoryCommentRepository(tasks, workspaces, users, activities);
  const notifications = new InMemoryNotificationRepository(workspaces, users, tasks, projects);
  const accounts = new InMemoryAccountRepository(users, sessions, notifications);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: workspaces,
    projectRepository: projects,
    taskRepository: tasks,
    commentRepository: comments,
    activityRepository: activities,
    notificationRepository: notifications,
    accountRepository: failing ? unreachableAccountRepository : accounts,
    env,
  });
  const login = async (email: string, password = PASSWORD) =>
    request(app).post('/api/v1/auth/login').send({ email, password });
  const signUp = async (email: string): Promise<Account> => {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const res = await login(email);
    return {
      id: registered.body.data.user.id,
      email,
      cookie: ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: res.body.data.csrfToken,
    };
  };
  return { app, users, sessions, workspaces, notifications, login, signUp };
}

describe('account: /api/v1/users/me', () => {
  let ctx: ReturnType<typeof setup>;
  let ada: Account;

  const authed = <T extends request.Test>(req: T, who = ada) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const me = (who = ada) => request(ctx.app).get('/api/v1/users/me').set('Cookie', who.cookie);
  const patchMe = (body: unknown, who = ada) =>
    authed(request(ctx.app).patch('/api/v1/users/me'), who).send(body as object);
  const changePassword = (body: unknown, who = ada) =>
    authed(request(ctx.app).patch('/api/v1/users/me/password'), who).send(body as object);
  const settings = (who = ada) =>
    request(ctx.app).get('/api/v1/users/me/settings').set('Cookie', who.cookie);
  const patchSettings = (body: unknown, who = ada) =>
    authed(request(ctx.app).patch('/api/v1/users/me/settings'), who).send(body as object);

  beforeEach(async () => {
    ctx = setup();
    ada = await ctx.signUp('ada@example.com');
  });

  it('requires a session on every endpoint', async () => {
    const calls = [
      request(ctx.app).get('/api/v1/users/me'),
      request(ctx.app).patch('/api/v1/users/me').send({ name: 'X' }),
      request(ctx.app).patch('/api/v1/users/me/password').send({}),
      request(ctx.app).get('/api/v1/users/me/settings'),
      request(ctx.app).patch('/api/v1/users/me/settings').send({ dateFormat: 'ISO' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
  });

  describe('profile', () => {
    it('returns only the signed-in user’s own profile, without secrets', async () => {
      const grace = await ctx.signUp('grace@example.com');
      const res = await me();
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data.user).toEqual({
        id: ada.id,
        email: 'ada@example.com',
        name: null,
        createdAt: expect.any(String),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|argon|session|token/i);
      expect((await me(grace)).body.data.user.id).toBe(grace.id);
    });

    it('updates the display name (normalized), and clears it with null or blank', async () => {
      const res = await patchMe({ name: '  Ada Lovelace ' });
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
      expect((await me()).body.data.user.name).toBe('Ada Lovelace');

      expect((await patchMe({ name: '   ' })).body.data.user.name).toBeNull();
      await patchMe({ name: 'Ada' });
      expect((await patchMe({ name: null })).body.data.user.name).toBeNull();
    });

    it.each([
      ['too long', { name: 'x'.repeat(101) }],
      ['control characters', { name: 'Ada\u0000' }],
      ['not a string', { name: 42 }],
      ['missing name', {}],
      ['an email change', { name: 'Ada', email: 'evil@example.com' }],
      ['other fields', { name: 'Ada', role: 'OWNER' }],
    ])('rejects %s (400) and changes nothing', async (_label, body) => {
      const res = await patchMe(body);
      expect(res.status).toBe(400);
      expect((await me()).body.data.user).toMatchObject({ email: 'ada@example.com', name: null });
    });

    it('requires the CSRF token to update', async () => {
      const res = await request(ctx.app)
        .patch('/api/v1/users/me')
        .set('Cookie', ada.cookie)
        .send({ name: 'X' });
      expect(res.status).toBe(403);
    });

    it('never touches workspace memberships or roles', async () => {
      const ws = await authed(request(ctx.app).post('/api/v1/workspaces')).send({ name: 'Team' });
      const id = ws.body.data.workspace.id as string;
      await patchMe({ name: 'Ada' });
      const detail = await request(ctx.app)
        .get(`/api/v1/workspaces/${id}`)
        .set('Cookie', ada.cookie);
      expect(detail.body.data.membership.role).toBe('OWNER');
      expect(ctx.workspaces.members.filter((m) => m.workspaceId === id)).toHaveLength(1);
    });
  });

  describe('password change', () => {
    it('verifies the current password, re-hashes and signs out every session', async () => {
      const otherDevice = await ctx.login('ada@example.com');
      const otherCookie = ([] as string[])
        .concat(otherDevice.headers['set-cookie'] ?? [])[0]!
        .split(';')[0]!;
      const before = ctx.users.rows.find((u) => u.id === ada.id)!.passwordHash;

      const res = await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ passwordChanged: true, signedOut: true });
      expect(String(res.headers['set-cookie'])).toMatch(/trackify_session=;/);
      expect(JSON.stringify(res.body)).not.toMatch(/hash|argon/i);

      const after = ctx.users.rows.find((u) => u.id === ada.id)!.passwordHash;
      expect(after).not.toBe(before);
      expect(after).toMatch(/^\$argon2id\$/);
      expect(ctx.sessions.rows.filter((s) => s.userId === ada.id)).toEqual([]);
      for (const cookie of [ada.cookie, otherCookie]) {
        expect((await request(ctx.app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(
          401,
        );
      }
      expect((await ctx.login('ada@example.com')).status).toBe(401);
      expect((await ctx.login('ada@example.com', NEW_PASSWORD)).status).toBe(200);
    });

    it('rejects a wrong current password (400, still signed in)', async () => {
      const res = await changePassword({
        currentPassword: 'not my password',
        newPassword: NEW_PASSWORD,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([
        { location: 'body', path: 'currentPassword', message: 'Current password is incorrect' },
      ]);
      expect((await me()).status).toBe(200);
      expect((await ctx.login('ada@example.com')).status).toBe(200);
    });

    it.each([
      ['a short new password', { currentPassword: PASSWORD, newPassword: 'short' }],
      ['a whitespace-only one', { currentPassword: PASSWORD, newPassword: ' '.repeat(12) }],
      ['an overly long one', { currentPassword: PASSWORD, newPassword: 'x'.repeat(129) }],
      ['the same password', { currentPassword: PASSWORD, newPassword: PASSWORD }],
      ['the email address', { currentPassword: PASSWORD, newPassword: 'ADA@example.com' }],
      ['a missing current password', { newPassword: NEW_PASSWORD }],
      ['extra fields', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: 'x' }],
    ])('rejects %s (400) and keeps the old password', async (_label, body) => {
      expect((await changePassword(body)).status).toBe(400);
      expect((await ctx.login('ada@example.com')).status).toBe(200);
    });

    it('limits failed attempts per user (429)', async () => {
      ctx = setup({ env: { LOGIN_ACCOUNT_RATE_LIMIT_MAX: '2' } });
      ada = await ctx.signUp('ada@example.com');
      const wrong = { currentPassword: 'wrong guess', newPassword: NEW_PASSWORD };
      expect((await changePassword(wrong)).status).toBe(400);
      expect((await changePassword(wrong)).status).toBe(400);
      expect((await changePassword(wrong)).status).toBe(429);
    });
  });

  describe('settings', () => {
    it('returns defaults until saved, then saves partial changes', async () => {
      expect((await settings()).body.data.settings).toEqual({
        timeZone: null,
        dateFormat: 'LOCALE',
        notifications: { taskAssigned: true, taskCommented: true, taskReminder: true },
      });

      const first = await patchSettings({ timeZone: 'Asia/Kolkata', dateFormat: 'ISO' });
      expect(first.status).toBe(200);
      const second = await patchSettings({ notifications: { taskCommented: false } });
      expect(second.body.data.settings).toEqual({
        timeZone: 'Asia/Kolkata',
        dateFormat: 'ISO',
        notifications: { taskAssigned: true, taskCommented: false, taskReminder: true },
      });
      expect((await settings()).body.data.settings).toEqual(second.body.data.settings);
      // Back to the device's zone.
      expect((await patchSettings({ timeZone: null })).body.data.settings.timeZone).toBeNull();
    });

    it('stores time zones in their canonical spelling', async () => {
      const res = await patchSettings({ timeZone: 'utc' });
      expect(res.body.data.settings.timeZone).toBe('UTC');
      expect(canonicalTimeZone('america/new_york')).toBe('America/New_York');
      expect(canonicalTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata'); // not ICU's legacy alias
      expect(canonicalTimeZone('Mars/Phobos')).toBeNull();
    });

    it.each([
      [{ timeZone: 'Mars/Phobos' }],
      [{ timeZone: '../../etc/passwd' }],
      [{ timeZone: 'x'.repeat(65) }],
      [{ timeZone: 3 }],
      [{ dateFormat: 'YYYY/MM/DD' }],
      [{ dateFormat: 'iso' }],
      [{}],
      [{ notifications: {} }],
      [{ notifications: { taskAssigned: 'no' } }],
      [{ notifications: { email: true } }],
      [{ theme: 'dark' }],
    ])('rejects %j (400)', async (body) => {
      expect((await patchSettings(body)).status).toBe(400);
      expect((await settings()).body.data.settings.dateFormat).toBe('LOCALE');
    });

    it('keeps each user’s settings separate', async () => {
      const grace = await ctx.signUp('grace@example.com');
      await patchSettings({ dateFormat: 'DMY' });
      expect((await settings(grace)).body.data.settings.dateFormat).toBe('LOCALE');
    });
  });

  describe('notification preferences', () => {
    it('stop new notifications of a type and hide existing ones until turned back on', async () => {
      const grace = await ctx.signUp('grace@example.com');
      const ws = (
        await authed(request(ctx.app).post('/api/v1/workspaces'), grace).send({ name: 'Team' })
      ).body.data.workspace.id as string;
      ctx.workspaces.addMember(ws, ada.id);
      const project = (
        await authed(request(ctx.app).post(`/api/v1/workspaces/${ws}/projects`), grace).send({
          name: 'P',
        })
      ).body.data.project.id as string;
      const tasks = `/api/v1/workspaces/${ws}/projects/${project}/tasks`;
      const newTask = async (title: string) =>
        (await authed(request(ctx.app).post(tasks), grace).send({ title })).body.data.task
          .id as string;
      const assignToAda = (id: string) =>
        authed(request(ctx.app).patch(`${tasks}/${id}/assignee`), grace).send({
          assigneeId: ada.id,
        });
      const inbox = async () =>
        (await request(ctx.app).get('/api/v1/notifications').set('Cookie', ada.cookie)).body.data
          .notifications as { type: string }[];
      const unread = async () =>
        (await request(ctx.app).get('/api/v1/notifications/unread-count').set('Cookie', ada.cookie))
          .body.data.unreadCount as number;

      const first = await newTask('First');
      await assignToAda(first);
      expect(await unread()).toBe(1);

      await patchSettings({ notifications: { taskAssigned: false } });
      expect(await inbox()).toEqual([]); // the existing one is hidden
      expect(await unread()).toBe(0);
      await assignToAda(await newTask('Second')); // not created at all
      expect(ctx.notifications.rows.filter((r) => r.recipientId === ada.id)).toHaveLength(1);

      // Other types still arrive.
      await authed(request(ctx.app).post(`${tasks}/${first}/comments`), grace).send({
        content: 'Hello',
      });
      expect((await inbox()).map((n) => n.type)).toEqual(['TASK_COMMENTED']);

      await patchSettings({ notifications: { taskAssigned: true } });
      expect((await inbox()).map((n) => n.type).sort()).toEqual([
        'TASK_ASSIGNED',
        'TASK_COMMENTED',
      ]);
      expect(await unread()).toBe(2);
    });
  });

  it('serves an unavailable database as a generic 503', async () => {
    ctx = setup({ failing: true });
    ada = await ctx.signUp('ada@example.com');
    const res = await me();
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|connection|sql/i);
  });
});
