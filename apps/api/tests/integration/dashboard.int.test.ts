/**
 * Workspace dashboard against the real, isolated test database: PostgreSQL's
 * own aggregation (COUNT … FILTER, LEFT JOIN for empty projects, the member
 * join that hides former members' emails) must match the business rules —
 * completed tasks are never overdue, undated tasks never overdue or upcoming,
 * archived projects' tasks left out, another workspace never leaks in. Rows
 * are tagged with a per-run email domain / workspace-name prefix and removed
 * afterwards.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} dashboard ${++counter}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Account {
  id: string;
  cookie: string;
}

describe.skipIf(!TEST_DATABASE_URL)('workspace dashboard with real PostgreSQL', () => {
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
    };
  };
  const workspaceWith = async (members: [Account, WorkspaceRole][]) => {
    const ws = await db.workspace.create({ data: { name: workspaceName() } });
    for (const [account, role] of members) {
      await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: account.id, role } });
    }
    return ws.id;
  };
  const newProject = async (workspaceId: string, name: string, createdAt: Date) =>
    (await db.project.create({ data: { workspaceId, name, createdById: owner.id, createdAt } })).id;
  const dashboard = async (who: Account, ws: string) => {
    const res = await request(app)
      .get(`/api/v1/workspaces/${ws}/dashboard`)
      .set('Cookie', who.cookie);
    expect(res.status).toBe(200);
    return res.body.data.dashboard;
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

  it('aggregates tasks, projects and my work in PostgreSQL', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const otherWs = await workspaceWith([[outsider, 'OWNER']]);
    const now = Date.now();
    const todayStart = new Date(new Date(now).setUTCHours(0, 0, 0, 0));
    const website = await newProject(ws, 'Website', new Date(now - 3 * DAY));
    const empty = await newProject(ws, 'Empty', new Date(now - 2 * DAY));
    const old = await newProject(ws, 'Old', new Date(now - DAY));
    const foreign = await newProject(otherWs, 'Theirs', new Date(now - DAY));
    await db.project.update({ where: { id: old }, data: { status: 'ARCHIVED' } });

    const task = (projectId: string, title: string, extra: object = {}) => ({
      projectId,
      title,
      createdById: owner.id,
      ...extra,
    });
    await db.task.createMany({
      data: [
        // Due at the start of today (UTC): overdue and due today.
        task(website, 'T', { priority: 'HIGH', dueDate: todayStart, assigneeId: member.id }),
        task(website, 'U', {
          status: 'IN_PROGRESS',
          priority: 'URGENT',
          dueDate: new Date(now + 3 * DAY),
          assigneeId: member.id,
        }),
        task(website, 'V', { dueDate: new Date(now - 2 * DAY), assigneeId: owner.id }),
        // Completed, with a past date: not overdue.
        task(website, 'W', {
          status: 'DONE',
          priority: 'LOW',
          dueDate: new Date(now - 5 * DAY),
          assigneeId: member.id,
        }),
        // Undated: neither overdue nor upcoming.
        task(website, 'X', { assigneeId: member.id }),
        task(website, 'Y', { dueDate: new Date(now + 10 * DAY) }),
        task(old, 'Archived', { dueDate: new Date(now - DAY), assigneeId: member.id }),
        task(foreign, 'Foreign', { dueDate: new Date(now - DAY), assigneeId: member.id }),
      ],
    });

    const d = await dashboard(member, ws);
    expect(d.tasks).toEqual({
      total: 6,
      byStatus: { TODO: 4, IN_PROGRESS: 1, DONE: 1 },
      byPriority: { LOW: 1, MEDIUM: 3, HIGH: 1, URGENT: 1 },
      overdue: 2,
      dueToday: 1,
      dueNext7Days: 1,
    });
    expect(d.projects).toEqual({
      active: 2,
      archived: 1,
      completion: [
        { id: empty, name: 'Empty', totalTasks: 0, doneTasks: 0, completionPercent: 0 },
        { id: website, name: 'Website', totalTasks: 6, doneTasks: 1, completionPercent: 16 },
      ],
    });
    expect(d.myWork).toMatchObject({ assigned: 4, pending: 3, overdue: 1, upcoming: 1 });
    // Soonest due first, undated last; never DONE, archived or foreign tasks.
    expect(d.myWork.tasks.map((t: { title: string }) => t.title)).toEqual(['T', 'U', 'X']);
    expect(d.myWork.tasks[0]).toEqual({
      id: expect.any(String),
      title: 'T',
      status: 'TODO',
      priority: 'HIGH',
      dueDate: todayStart.toISOString(),
      project: { id: website, name: 'Website' },
    });

    const mine = (await dashboard(owner, ws)).myWork;
    expect(mine).toMatchObject({ assigned: 1, pending: 1, overdue: 1, upcoming: 0 });
    expect(
      (await request(app).get(`/api/v1/workspaces/${ws}/dashboard`).set('Cookie', outsider.cookie))
        .status,
    ).toBe(404);
  }, 120_000);

  it('lists the 10 latest workspace activities, hiding former members', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const otherWs = await workspaceWith([[outsider, 'OWNER']]);
    const base = Date.now() - DAY;
    const active = await newProject(ws, 'Active', new Date(base));
    const archived = await newProject(ws, 'Archived', new Date(base));
    const foreign = await newProject(otherWs, 'Theirs', new Date(base));
    await db.project.update({ where: { id: archived }, data: { status: 'ARCHIVED' } });
    const [a, b, f] = await Promise.all(
      [
        [active, 'Task A'],
        [archived, 'Task B'],
        [foreign, 'Task F'],
      ].map(
        async ([projectId, title]) =>
          (
            await db.task.create({
              data: { projectId: projectId!, title: title!, createdById: owner.id },
            })
          ).id,
      ),
    );
    // 12 entries here, alternating projects; the newest is by someone who is not a member.
    await db.taskActivity.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({
        taskId: i % 2 === 0 ? a! : b!,
        userId: i === 11 ? outsider.id : member.id,
        type: 'TASK_CREATED' as const,
        metadata: { priority: 'MEDIUM' },
        createdAt: new Date(base + i * 60_000),
      })),
    });
    // Newer than all of them, but in another workspace.
    await db.taskActivity.create({
      data: {
        taskId: f!,
        userId: outsider.id,
        type: 'TASK_CREATED',
        metadata: { priority: 'MEDIUM' },
        createdAt: new Date(base + HOUR),
      },
    });

    const { recentActivity } = await dashboard(member, ws);
    expect(recentActivity).toHaveLength(10);
    expect(recentActivity[0]).toEqual({
      id: expect.any(String),
      type: 'TASK_CREATED',
      createdAt: new Date(base + 11 * 60_000).toISOString(),
      actorId: outsider.id,
      actor: null,
      task: { id: b, title: 'Task B' },
      project: { id: archived, name: 'Archived' },
    });
    expect(recentActivity[1]).toMatchObject({
      actor: { id: member.id, email: `member@${RUN_DOMAIN}` },
      task: { id: a, title: 'Task A' },
      project: { id: active, name: 'Active' },
    });
    expect(recentActivity.at(-1).createdAt).toBe(new Date(base + 2 * 60_000).toISOString());
    expect(recentActivity.some((x: { task: { id: string } }) => x.task.id === f)).toBe(false);
  }, 120_000);
});
