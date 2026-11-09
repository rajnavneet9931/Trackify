/**
 * In-app notifications against the real, isolated test database: they are
 * created in the same transaction as the assignment, comment or reminder
 * delivery (so failures create none), the unique (recipient, event key)
 * index prevents duplicates even for retried or concurrent writers, and every
 * read or write is scoped to the recipient in SQL. Reminder notifications are
 * covered in reminder.int.test.ts, whose processors must not race these. Rows are tagged with a per-run email domain /
 * workspace-name prefix and removed afterwards.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { createNotifications, taskReminder } from '../../src/modules/notifications/index.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} notifications ${++counter}`;

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('notifications with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let owner: Account;
  let member: Account;
  let colleague: Account;
  let outsider: Account;

  const signUp = async (local: string): Promise<Account> => {
    const email = `${local}@${RUN_DOMAIN}`;
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return {
      id: registered.body.data.user.id,
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: login.body.data.csrfToken,
    };
  };
  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const workspaceWith = async (members: [Account, WorkspaceRole][]) => {
    const ws = await db.workspace.create({ data: { name: workspaceName() } });
    for (const [account, role] of members) {
      await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: account.id, role } });
    }
    return ws.id;
  };
  /** A workspace with everyone but the outsider, one project and one task by the owner. */
  const fixture = async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
      [colleague, 'MEMBER'],
    ]);
    const project = (
      await db.project.create({ data: { workspaceId: ws, name: 'P', createdById: owner.id } })
    ).id;
    const base = `/api/v1/workspaces/${ws}/projects/${project}/tasks`;
    const created = await authed(request(app).post(base), owner).send({ title: 'Ship it' });
    expect(created.status).toBe(201);
    const task = created.body.data.task.id as string;
    return { ws, project, task, path: `${base}/${task}` };
  };
  const mine = (who: Account, workspaceId: string) =>
    db.notification.findMany({
      where: { recipientId: who.id, workspaceId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '8',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
    owner = await signUp('owner');
    member = await signUp('member');
    colleague = await signUp('colleague');
    outsider = await signUp('outsider');
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('creates assignment and comment notifications in the operation’s transaction', async () => {
    const { ws, project, task, path } = await fixture();
    const assign = (who: Account, assigneeId: string | null) =>
      authed(request(app).patch(`${path}/assignee`), who).send({ assigneeId });

    expect((await assign(owner, outsider.id)).status).toBe(422); // failed: nothing
    expect((await assign(member, member.id)).status).toBe(200); // self: nothing
    expect((await assign(owner, colleague.id)).status).toBe(200); // reassigned
    expect(await db.notification.count({ where: { workspaceId: ws } })).toBe(1);
    const [assigned] = await mine(colleague, ws);
    expect(assigned).toMatchObject({
      type: 'TASK_ASSIGNED',
      title: 'Task reassigned to you',
      actorId: owner.id,
      resourceType: 'TASK',
      resourceId: task,
      isRead: false,
    });

    // The owner created it and the colleague is assigned: the member's comment notifies both.
    const comment = await authed(request(app).post(`${path}/comments`), member).send({
      content: 'Private detail',
    });
    expect(comment.status).toBe(201);
    expect((await mine(colleague, ws)).map((n) => n.type)).toEqual([
      'TASK_ASSIGNED',
      'TASK_COMMENTED',
    ]);
    expect((await mine(owner, ws)).map((n) => n.message)).toEqual([
      'New comment on “Ship it”, which you created.',
    ]);
    expect(await mine(member, ws)).toEqual([]);
    const all = await db.notification.findMany({ where: { workspaceId: ws } });
    expect(JSON.stringify(all)).not.toContain('Private detail');

    // Read back through the API with a navigation target.
    const res = await request(app).get('/api/v1/notifications').set('Cookie', colleague.cookie);
    const latest = res.body.data.notifications[0];
    expect(latest).toMatchObject({
      type: 'TASK_COMMENTED',
      actor: { id: member.id, email: `member@${RUN_DOMAIN}` },
      target: { workspaceId: ws, projectId: project, taskId: task },
    });
  }, 120_000);

  it('rejects duplicates per recipient and event at the database level', async () => {
    const { ws, task } = await fixture();
    const input = taskReminder({
      recipientId: member.id,
      taskId: task,
      taskTitle: 'Ship it',
      dueDate: null,
      reminderId: randomUUID(),
    });
    const write = () =>
      db.$transaction((tx) => createNotifications(tx, { workspaceId: ws, actorId: null }, [input]));
    // Concurrent writers for the same event: exactly one row survives.
    const counts = await Promise.all([write(), write(), write()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(
      await db.notification.count({ where: { recipientId: member.id, workspaceId: ws } }),
    ).toBe(1);
    // Duplicates within one call, the actor and non-members are dropped too.
    const created = await db.$transaction((tx) =>
      createNotifications(tx, { workspaceId: ws, actorId: owner.id }, [
        { ...input, recipientId: colleague.id, eventKey: 'x:1' },
        { ...input, recipientId: colleague.id, eventKey: 'x:1' },
        { ...input, recipientId: owner.id, eventKey: 'x:1' },
        { ...input, recipientId: outsider.id, eventKey: 'x:1' },
      ]),
    );
    expect(created).toBe(1);
  }, 60_000);

  it('creates nothing when the surrounding transaction rolls back', async () => {
    const { ws, task } = await fixture();
    const eventKey = `rollback:${randomUUID()}`;
    await expect(
      db.$transaction(async (tx) => {
        await createNotifications(tx, { workspaceId: ws, actorId: owner.id }, [
          {
            ...taskReminder({
              recipientId: member.id,
              taskId: task,
              taskTitle: 'Ship it',
              dueDate: null,
              reminderId: randomUUID(),
            }),
            eventKey,
          },
        ]);
        throw new Error('operation failed after notifying');
      }),
    ).rejects.toThrow('operation failed after notifying');
    expect(await db.notification.count({ where: { eventKey } })).toBe(0);
  }, 60_000);

  it('scopes listing, counts and changes to the recipient in SQL', async () => {
    // Fresh accounts: nothing from the other tests in their inboxes.
    const reader = await signUp('reader');
    const other = await signUp('other');
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [reader, 'MEMBER'],
      [other, 'MEMBER'],
    ]);
    const project = (
      await db.project.create({ data: { workspaceId: ws, name: 'P', createdById: owner.id } })
    ).id;
    const base = `/api/v1/workspaces/${ws}/projects/${project}/tasks`;
    const task = (await authed(request(app).post(base), owner).send({ title: 'Ship it' })).body.data
      .task.id as string;
    const path = `${base}/${task}`;
    const member = reader;
    const colleague = other;
    for (const assignee of [member.id, colleague.id, member.id]) {
      await authed(request(app).patch(`${path}/assignee`), owner).send({ assigneeId: assignee });
    }
    const list = (who: Account, query: Record<string, string> = {}) =>
      request(app).get('/api/v1/notifications').query(query).set('Cookie', who.cookie);
    const count = async (who: Account) =>
      (await request(app).get('/api/v1/notifications/unread-count').set('Cookie', who.cookie)).body
        .data.unreadCount as number;

    const first = await list(member, { limit: '1' });
    expect(first.body.data.notifications).toHaveLength(1);
    const second = await list(member, { limit: '1', cursor: first.body.meta.nextCursor });
    expect(second.body.data.notifications).toHaveLength(1);
    expect(second.body.meta.nextCursor).toBeNull();
    const [newest, older] = [first.body.data.notifications[0], second.body.data.notifications[0]];
    expect(newest.createdAt >= older.createdAt).toBe(true);
    expect(await count(member)).toBe(2);

    // Another user can do nothing with them.
    expect(
      (await authed(request(app).patch(`/api/v1/notifications/${newest.id}/read`), colleague))
        .status,
    ).toBe(404);
    expect(
      (await authed(request(app).delete(`/api/v1/notifications/${newest.id}`), outsider)).status,
    ).toBe(404);
    await authed(request(app).patch('/api/v1/notifications/read-all'), colleague);
    expect(await count(member)).toBe(2);

    const read = await authed(
      request(app).patch(`/api/v1/notifications/${newest.id}/read`),
      member,
    );
    expect(read.body.data.notification).toMatchObject({ isRead: true });
    expect(await count(member)).toBe(1);
    expect((await list(member, { unreadOnly: 'true' })).body.data.notifications).toHaveLength(1);
    const all = await authed(request(app).patch('/api/v1/notifications/read-all'), member);
    expect(all.body.data.updated).toBe(1);
    expect(await count(member)).toBe(0);
    expect(
      (await authed(request(app).delete(`/api/v1/notifications/${older.id}`), member)).status,
    ).toBe(200);
    expect((await list(member)).body.data.notifications.map((n: { id: string }) => n.id)).toEqual([
      newest.id,
    ]);

    // A deleted task leaves the notification without a target.
    await db.task.delete({ where: { id: task } });
    expect((await list(member)).body.data.notifications[0]).toMatchObject({
      resourceId: task,
      target: null,
    });
    // Leaving the workspace hides its notifications.
    await db.workspaceMember.deleteMany({ where: { workspaceId: ws, userId: member.id } });
    expect((await list(member)).body.data.notifications).toEqual([]);
    expect(
      (await authed(request(app).patch(`/api/v1/notifications/${newest.id}/read`), member)).status,
    ).toBe(404);
  }, 120_000);
});
