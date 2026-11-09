/**
 * The project-level task workflow end to end against the real, isolated test
 * database: create a task with a status and an assignee in one request (one
 * transaction: the row, its history and the assignee's notification), refuse
 * a non-member assignee without leaving anything behind, change the status,
 * and see the workspace dashboard count exactly the persisted tasks. Rows are
 * tagged with a per-run email domain / workspace-name prefix and removed
 * afterwards.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('task workflow with real PostgreSQL', () => {
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
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: login.body.data.csrfToken,
    };
  };
  const call = (who: Account, method: 'get' | 'post' | 'patch', path: string, body?: object) => {
    const req = request(app)
      [method](`/api/v1${path}`)
      .set('Cookie', who.cookie)
      .set('X-CSRF-Token', who.csrfToken);
    return body ? req.send(body) : req;
  };

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '5',
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

  it('creates, assigns and updates tasks, and the dashboard counts what is stored', async () => {
    const ws = await db.workspace.create({ data: { name: `it-${RUN} workflow` } });
    await db.workspaceMember.createMany({
      data: [
        { workspaceId: ws.id, userId: owner.id, role: 'OWNER' },
        { workspaceId: ws.id, userId: member.id, role: 'MEMBER' },
      ],
    });
    const project = await call(owner, 'post', `/workspaces/${ws.id}/projects`, { name: 'P' });
    const projectId = project.body.data.project.id as string;
    const tasksPath = `/workspaces/${ws.id}/projects/${projectId}/tasks`;

    // A non-member assignee: 422 and nothing stored at all.
    const refused = await call(owner, 'post', tasksPath, {
      title: 'Nope',
      assigneeId: outsider.id,
    });
    expect(refused.status).toBe(422);
    expect(await db.task.count({ where: { projectId } })).toBe(0);
    expect(await db.notification.count({ where: { workspaceId: ws.id } })).toBe(0);

    const created = await call(owner, 'post', tasksPath, {
      title: 'Launch',
      description: 'Ship v1',
      status: 'IN_PROGRESS',
      priority: 'URGENT',
      assigneeId: member.id,
      dueDate: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    expect(created.status).toBe(201);
    const taskId = created.body.data.task.id as string;
    expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      status: 'IN_PROGRESS',
      priority: 'URGENT',
      assigneeId: member.id,
      createdById: owner.id,
    });
    const history = await db.taskActivity.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(history.map((a) => a.type)).toEqual(['TASK_CREATED', 'ASSIGNEE_CHANGED']);
    expect(await db.notification.findMany({ where: { resourceId: taskId } })).toEqual([
      expect.objectContaining({ recipientId: member.id, type: 'TASK_ASSIGNED' }),
    ]);
    expect(
      (await call(owner, 'post', tasksPath, { title: 'Second', priority: 'LOW' })).status,
    ).toBe(201);

    const dashboard = async (who: Account) =>
      (await call(who, 'get', `/workspaces/${ws.id}/dashboard`)).body.data.dashboard;
    let d = await dashboard(member);
    expect(d.tasks).toMatchObject({
      total: 2,
      byStatus: { TODO: 1, IN_PROGRESS: 1, DONE: 0 },
      byPriority: { LOW: 1, MEDIUM: 0, HIGH: 0, URGENT: 1 },
      dueNext7Days: 1,
    });
    expect(d.myWork).toMatchObject({ assigned: 1, pending: 1, upcoming: 1 });

    // Status update from the list (PATCH with the version seen).
    const done = await call(member, 'patch', `${tasksPath}/${taskId}`, {
      status: 'DONE',
      expectedUpdatedAt: created.body.data.task.updatedAt,
    });
    expect(done.status).toBe(200);
    d = await dashboard(member);
    expect(d.tasks.byStatus).toEqual({ TODO: 1, IN_PROGRESS: 0, DONE: 1 });
    expect(d.tasks.dueNext7Days).toBe(0); // completed tasks are no longer upcoming
    expect(d.projects.completion).toEqual([
      expect.objectContaining({
        id: projectId,
        totalTasks: 2,
        doneTasks: 1,
        completionPercent: 50,
      }),
    ]);

    // The list shows both, filterable by status and assignee.
    const mine = await call(member, 'get', `${tasksPath}?assigneeId=${member.id}`);
    expect(mine.body.data.tasks.map((t: { title: string }) => t.title)).toEqual(['Launch']);
    const todo = await call(member, 'get', `${tasksPath}?status=TODO`);
    expect(todo.body.data.tasks.map((t: { title: string }) => t.title)).toEqual(['Second']);
  }, 180_000);
});
