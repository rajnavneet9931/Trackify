/**
 * Due dates, reminder scheduling, the reminder processor and the in-app
 * notifications API against the real, isolated test database: scheduling in
 * the task transaction, exactly-once delivery (idempotent runs, two
 * "instances" with separate connection pools racing), catch-up after a
 * restart, recipient rules, archived projects, retries and failures, and the
 * recipient-only inbox. Rows are tagged with a per-run email domain /
 * workspace-name prefix and removed afterwards (workspaces cascade to tasks
 * and reminders; then users).
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { PrismaReminderRepository, ReminderProcessor } from '../../src/modules/reminders/index.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} reminders ${++counter}`;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('due dates and reminders with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let owner: Account;
  let member: Account;
  let outsider: Account;

  const signUp = async (local: string): Promise<Account> => {
    const email = `${local}@${RUN_DOMAIN}`;
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
  const workspaceWith = async (members: [Account, WorkspaceRole][]) => {
    const ws = await db.workspace.create({ data: { name: workspaceName() } });
    for (const [account, role] of members) {
      await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: account.id, role } });
    }
    return ws.id;
  };
  const newProject = async (workspaceId: string) =>
    (await db.project.create({ data: { workspaceId, name: 'Project', createdById: owner.id } })).id;
  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const tasksPath = (ws: string, p: string) => `/api/v1/workspaces/${ws}/projects/${p}/tasks`;
  const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const createTask = async (who: Account, ws: string, p: string, body: object) => {
    const res = await authed(request(app).post(tasksPath(ws, p)), who).send({
      title: 'Task',
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body.data.task.id as string;
  };
  /** A task whose reminder is already due (1 minute ago), due tomorrow. */
  const dueTask = (who: Account, ws: string, p: string) =>
    createTask(who, ws, p, { dueDate: minutesFromNow(24 * 60), reminderAt: minutesFromNow(-1) });
  const remindersOf = (taskId: string) =>
    db.taskReminder.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { status: true, recipientId: true, attempts: true, lastError: true, sentAt: true },
    });
  const processor = (client = db, options = {}) =>
    new ReminderProcessor(new PrismaReminderRepository(client), silent, options);
  const inbox = (who: Account, query: Record<string, string> = {}) =>
    request(app).get('/api/v1/notifications').query(query).set('Cookie', who.cookie);

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
    outsider = await signUp('outsider');
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('stores due dates in UTC and schedules exactly one pending reminder per task', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    const id = await createTask(member, ws, project, {
      dueDate: '2026-12-01T18:30:00+05:30',
      reminderAt: '2026-12-01T06:00:00-05:00',
    });
    const task = await db.task.findUniqueOrThrow({ where: { id } });
    expect(task.dueDate!.toISOString()).toBe('2026-12-01T13:00:00.000Z');
    expect(task.reminderAt!.toISOString()).toBe('2026-12-01T11:00:00.000Z');
    expect((await remindersOf(id)).map((r) => r.status)).toEqual(['PENDING']);

    const version = { expectedUpdatedAt: task.updatedAt.toISOString() };
    const edited = await authed(request(app).patch(`${tasksPath(ws, project)}/${id}`), member).send(
      {
        reminderAt: '2026-12-01T12:00:00Z',
        ...version,
      },
    );
    expect(edited.status).toBe(200);
    expect((await remindersOf(id)).map((r) => r.status)).toEqual(['CANCELLED', 'PENDING']);

    // The partial unique index refuses a second pending reminder outright.
    await expect(
      db.taskReminder.create({ data: { taskId: id, remindAt: new Date() } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const bad = await authed(request(app).patch(`${tasksPath(ws, project)}/${id}`), member).send({
      dueDate: null,
      expectedUpdatedAt: (
        await db.task.findUniqueOrThrow({ where: { id } })
      ).updatedAt.toISOString(),
    });
    expect(bad.status).toBe(400);
    expect((await db.task.findUniqueOrThrow({ where: { id } })).dueDate).not.toBeNull();
  }, 60_000);

  it('delivers a due reminder once, to the assignee, else the creator; repeat runs do nothing', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const assigned = await dueTask(owner, ws, project);
    await authed(request(app).patch(`${tasksPath(ws, project)}/${assigned}/assignee`), owner).send({
      assigneeId: member.id,
    });
    const unassigned = await dueTask(member, ws, project);
    const future = await createTask(member, ws, project, {
      dueDate: minutesFromNow(48 * 60),
      reminderAt: minutesFromNow(24 * 60),
    });

    await processor().runOnce();
    await processor().runOnce(); // idempotent

    const [a] = await remindersOf(assigned);
    expect(a).toMatchObject({ status: 'SENT', recipientId: member.id, attempts: 0 });
    expect(a!.sentAt).not.toBeNull();
    const [u] = await remindersOf(unassigned);
    expect(u).toMatchObject({ status: 'SENT', recipientId: member.id }); // creator
    expect((await remindersOf(future)).map((r) => r.status)).toEqual(['PENDING']);

    const detail = await request(app)
      .get(`${tasksPath(ws, project)}/${assigned}`)
      .set('Cookie', owner.cookie);
    expect(detail.body.data.reminder).toMatchObject({ status: 'SENT', sentAt: expect.any(String) });
  }, 60_000);

  it('catches up reminders missed while no instance was running (a fresh process)', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    const missed = [await dueTask(member, ws, project), await dueTask(member, ws, project)];
    // Pretend they came due hours ago, while the API was down.
    await db.taskReminder.updateMany({
      where: { taskId: { in: missed } },
      data: { remindAt: new Date(Date.now() - 6 * 3_600_000) },
    });

    // A "restarted" instance: brand-new client and processor.
    const { db: restarted } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, { DATABASE_CONNECT_TIMEOUT_MS: '15000' }),
    );
    try {
      await assertIsTestDatabase(restarted);
      await processor(restarted).runOnce();
    } finally {
      await restarted.$disconnect();
    }
    for (const id of missed) {
      expect((await remindersOf(id))[0]).toMatchObject({ status: 'SENT', recipientId: member.id });
    }
  }, 60_000);

  it('two instances racing deliver every reminder exactly once (SKIP LOCKED)', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await dueTask(member, ws, project));

    const second = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '4',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ).db;
    try {
      await assertIsTestDatabase(second);
      const results = await Promise.all([processor().runOnce(), processor(second).runOnce()]);
      expect(results.every((r) => r.errors === 0)).toBe(true);
    } finally {
      await second.$disconnect();
    }
    for (const id of ids) {
      const rows = await remindersOf(id);
      expect(rows.map((r) => r.status)).toEqual(['SENT']);
    }
  }, 120_000);

  it('cancels reminders of archived projects; fails when nobody can receive it', async () => {
    const leaver = await signUp('leaver');
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [leaver, 'MEMBER'],
    ]);
    const archivedProject = await newProject(ws);
    const activeProject = await newProject(ws);
    const archivedTask = await dueTask(owner, ws, archivedProject);
    const orphanTask = await dueTask(leaver, ws, activeProject); // created by the leaver
    await db.project.update({ where: { id: archivedProject }, data: { status: 'ARCHIVED' } });
    await db.workspaceMember.deleteMany({ where: { workspaceId: ws, userId: leaver.id } });

    await processor().runOnce();

    expect((await remindersOf(archivedTask))[0]).toMatchObject({
      status: 'CANCELLED',
      lastError: 'Project archived',
      recipientId: null,
    });
    expect((await remindersOf(orphanTask))[0]).toMatchObject({
      status: 'FAILED',
      lastError: 'No eligible recipient',
      recipientId: null,
    });
  }, 60_000);

  it('retries failed deliveries, then marks them FAILED (rolled back each time)', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    const id = await dueTask(member, ws, project);
    const failing = processor(db, {
      maxAttempts: 2,
      deliver: async () => {
        throw new Error('channel down');
      },
    });

    const first = await failing.runOnce();
    expect(first.errors).toBeGreaterThanOrEqual(1);
    expect((await remindersOf(id))[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'channel down',
      recipientId: null,
      sentAt: null,
    });

    await failing.runOnce();
    expect((await remindersOf(id))[0]).toMatchObject({ status: 'FAILED', attempts: 2 });
    // Every failed attempt rolled its notification back with it.
    expect(await db.notification.count({ where: { resourceId: id } })).toBe(0);
    await processor().runOnce(); // a FAILED reminder is never retried again
    expect((await remindersOf(id))[0]).toMatchObject({ status: 'FAILED', attempts: 2 });
  }, 60_000);

  it('the inbox shows only the recipient’s delivered reminders; read marks are idempotent', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const id = await dueTask(member, ws, project);
    await processor().runOnce();

    const res = await inbox(member);
    expect(res.status).toBe(200);
    const mine = res.body.data.notifications.find(
      (n: { resourceId: string }) => n.resourceId === id,
    );
    expect(mine).toMatchObject({
      type: 'TASK_REMINDER',
      title: 'Task due soon',
      message: expect.stringMatching(/^“Task” is due \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/),
      workspaceId: ws,
      resourceType: 'TASK',
      resourceId: id,
      actorId: null,
      actor: null,
      isRead: false,
      readAt: null,
      target: { workspaceId: ws, projectId: project, taskId: id },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session|token/i);
    expect(
      (await inbox(owner)).body.data.notifications.some(
        (n: { resourceId: string }) => n.resourceId === id,
      ),
    ).toBe(false);

    const read = (who: Account) =>
      authed(request(app).post(`/api/v1/notifications/${mine.id}/read`), who);
    expect((await read(outsider)).status).toBe(404);
    expect((await read(owner)).status).toBe(404);
    const once = await read(member);
    expect(once.status).toBe(200);
    expect(once.body.data.notification.readAt).toEqual(expect.any(String));
    const twice = await read(member);
    expect(twice.body.data.notification.readAt).toBe(once.body.data.notification.readAt);

    // Removed from the workspace: their notifications from it disappear.
    await db.workspaceMember.deleteMany({ where: { workspaceId: ws, userId: member.id } });
    expect(
      (await inbox(member)).body.data.notifications.some(
        (n: { resourceId: string }) => n.resourceId === id,
      ),
    ).toBe(false);
    expect((await read(member)).status).toBe(404);
  }, 60_000);

  it('creates exactly one notification per reminder, however often it is processed', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const id = await dueTask(member, ws, project);

    await Promise.all([processor().runOnce(), processor().runOnce(), processor().runOnce()]);
    await processor().runOnce();

    const [reminder] = await db.taskReminder.findMany({ where: { taskId: id } });
    expect(reminder).toMatchObject({ status: 'SENT', recipientId: member.id });
    const notifications = await db.notification.findMany({ where: { resourceId: id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      recipientId: member.id,
      workspaceId: ws,
      type: 'TASK_REMINDER',
      actorId: null,
      eventKey: `reminder:${reminder!.id}`,
    });
  }, 90_000);

  it('paginates the inbox newest first with user-bound cursors', async () => {
    const reader = await signUp('reader');
    const ws = await workspaceWith([[reader, 'MEMBER']]);
    const project = await newProject(ws);
    for (let i = 0; i < 3; i++) await dueTask(reader, ws, project);
    await processor().runOnce();

    const first = await inbox(reader, { limit: '2' });
    expect(first.body.data.notifications).toHaveLength(2);
    const second = await inbox(reader, { limit: '2', cursor: first.body.meta.nextCursor });
    expect(second.body.data.notifications).toHaveLength(1);
    expect(second.body.meta.nextCursor).toBeNull();
    const all = [...first.body.data.notifications, ...second.body.data.notifications];
    const times = all.map((n: { createdAt: string }) => n.createdAt);
    expect(times.every(Boolean)).toBe(true);
    expect([...times].sort().reverse()).toEqual(times);
    expect(new Set(all.map((n: { id: string }) => n.id)).size).toBe(3);

    expect((await inbox(member, { cursor: first.body.meta.nextCursor })).status).toBe(400);
  }, 90_000);
});
