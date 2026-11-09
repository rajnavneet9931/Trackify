/**
 * Profile, password and settings against the real, isolated test database:
 * a password change replaces the Argon2id hash and deletes every session row
 * of the user in one transaction, a failed change touches nothing, settings
 * are created on first save (concurrent first saves leave exactly one row),
 * and notification preferences are applied by the notification writer and
 * the inbox queries. Rows are tagged with a per-run email domain /
 * workspace-name prefix and removed afterwards.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { createNotifications, taskReminder } from '../../src/modules/notifications/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new passphrase';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('account with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;

  const login = (email: string, password = PASSWORD) =>
    request(app).post('/api/v1/auth/login').send({ email, password });
  const signUp = async (local: string): Promise<Account> => {
    const email = `${local}@${RUN_DOMAIN}`;
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
  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '5',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('updates only the display name', async () => {
    const ada = await signUp('ada');
    const ws = await db.workspace.create({ data: { name: `it-${RUN} profile` } });
    await db.workspaceMember.create({
      data: { workspaceId: ws.id, userId: ada.id, role: 'OWNER' },
    });
    const before = await db.user.findUniqueOrThrow({ where: { id: ada.id } });

    const res = await authed(request(app).patch('/api/v1/users/me'), ada).send({ name: 'Ada L.' });
    expect(res.status).toBe(200);
    const after = await db.user.findUniqueOrThrow({ where: { id: ada.id } });
    expect(after).toMatchObject({
      name: 'Ada L.',
      email: before.email,
      passwordHash: before.passwordHash,
    });
    expect(await db.workspaceMember.findMany({ where: { userId: ada.id } })).toEqual([
      expect.objectContaining({ workspaceId: ws.id, role: 'OWNER' }),
    ]);
    const email = await authed(request(app).patch('/api/v1/users/me'), ada).send({
      name: 'Ada',
      email: `other@${RUN_DOMAIN}`,
    });
    expect(email.status).toBe(400);
    expect((await db.user.findUniqueOrThrow({ where: { id: ada.id } })).email).toBe(before.email);
  }, 60_000);

  it('changes the password and deletes every session of the user, and only theirs', async () => {
    const ada = await signUp('changer');
    const grace = await signUp('bystander');
    await login(ada.email); // a second session (another device)
    expect(await db.session.count({ where: { userId: ada.id } })).toBe(2);
    const oldHash = (await db.user.findUniqueOrThrow({ where: { id: ada.id } })).passwordHash;

    const wrong = await authed(request(app).patch('/api/v1/users/me/password'), ada).send({
      currentPassword: 'definitely wrong',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(400);
    expect(await db.session.count({ where: { userId: ada.id } })).toBe(2);
    expect((await db.user.findUniqueOrThrow({ where: { id: ada.id } })).passwordHash).toBe(oldHash);

    const res = await authed(request(app).patch('/api/v1/users/me/password'), ada).send({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    const newHash = (await db.user.findUniqueOrThrow({ where: { id: ada.id } })).passwordHash;
    expect(newHash).not.toBe(oldHash);
    expect(newHash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/); // registration's parameters
    expect(await db.session.count({ where: { userId: ada.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: grace.id } })).toBe(1);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', ada.cookie)).status).toBe(401);
    expect((await login(ada.email)).status).toBe(401);
    expect((await login(ada.email, NEW_PASSWORD)).status).toBe(200);
  }, 120_000);

  it('creates settings on first save, exactly once under concurrency', async () => {
    const ada = await signUp('settings');
    expect(await db.userSettings.count({ where: { userId: ada.id } })).toBe(0);
    const results = await Promise.all([
      authed(request(app).patch('/api/v1/users/me/settings'), ada).send({ dateFormat: 'ISO' }),
      authed(request(app).patch('/api/v1/users/me/settings'), ada).send({
        timeZone: 'Asia/Kolkata',
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await db.userSettings.findMany({ where: { userId: ada.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dateFormat: 'ISO', timeZone: 'Asia/Kolkata' });

    const res = await request(app).get('/api/v1/users/me/settings').set('Cookie', ada.cookie);
    expect(res.body.data.settings).toEqual({
      timeZone: 'Asia/Kolkata',
      dateFormat: 'ISO',
      notifications: { taskAssigned: true, taskCommented: true, taskReminder: true },
    });
  }, 60_000);

  it('applies notification preferences when creating and when listing', async () => {
    const ada = await signUp('muted');
    const grace = await signUp('notifier');
    const ws = await db.workspace.create({ data: { name: `it-${RUN} prefs` } });
    for (const [user, role] of [
      [grace, 'OWNER'],
      [ada, 'MEMBER'],
    ] as const) {
      await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role } });
    }
    const project = await db.project.create({
      data: { workspaceId: ws.id, name: 'P', createdById: grace.id },
    });
    const task = await db.task.create({
      data: { projectId: project.id, title: 'T', createdById: grace.id },
    });
    const reminder = (key: string) => ({
      ...taskReminder({
        recipientId: ada.id,
        taskId: task.id,
        taskTitle: 'T',
        dueDate: null,
        reminderId: randomUUID(),
      }),
      eventKey: key,
    });
    const write = (key: string) =>
      db.$transaction((tx) =>
        createNotifications(tx, { workspaceId: ws.id, actorId: null }, [reminder(key)]),
      );
    const count = async () =>
      (await request(app).get('/api/v1/notifications/unread-count').set('Cookie', ada.cookie)).body
        .data.unreadCount as number;

    expect(await write('before')).toBe(1);
    expect(await count()).toBe(1);

    await authed(request(app).patch('/api/v1/users/me/settings'), ada).send({
      notifications: { taskReminder: false },
    });
    expect(await write('while-muted')).toBe(0); // never created
    expect(await count()).toBe(0); // the existing one is hidden
    const list = await request(app).get('/api/v1/notifications').set('Cookie', ada.cookie);
    expect(list.body.data.notifications).toEqual([]);

    await authed(request(app).patch('/api/v1/users/me/settings'), ada).send({
      notifications: { taskReminder: true },
    });
    expect(await count()).toBe(1);
    expect(await db.notification.count({ where: { recipientId: ada.id } })).toBe(1);
  }, 120_000);

  it('removes settings with the account', async () => {
    const ada = await signUp('deleted');
    await authed(request(app).patch('/api/v1/users/me/settings'), ada).send({ dateFormat: 'MDY' });
    await db.user.delete({ where: { id: ada.id } });
    expect(await db.userSettings.count({ where: { userId: ada.id } })).toBe(0);
  }, 60_000);
});
