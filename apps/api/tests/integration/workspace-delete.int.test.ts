/**
 * Workspace deletion against the real, isolated test database. A workspace
 * full of dependent rows (members, a pending invitation, projects, tasks with
 * a pending reminder, comments, activity history, notifications) is deleted by
 * its owner; PostgreSQL's ON DELETE CASCADE must remove every one of those
 * rows in the same transaction, leave no orphans, and leave a second
 * workspace that shares the same users, plus the users, their sessions and
 * settings, exactly as they were. Rows are tagged with a per-run email
 * domain / workspace-name prefix and removed afterwards.
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
let counter = 0;
const workspaceName = () => `it-${RUN} delete ${++counter}`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('workspace deletion with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let owner: Account;
  let member: Account;
  let invitee: Account;

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
  const call = (who: Account, method: 'post' | 'patch' | 'delete', path: string, body?: object) => {
    const req = request(app)
      [method](`/api/v1${path}`)
      .set('Cookie', who.cookie)
      .set('X-CSRF-Token', who.csrfToken);
    return body ? req.send(body) : req;
  };

  /**
   * A workspace with every kind of dependent row, created through the API so
   * activities, reminders and notifications are written as in production.
   */
  const populate = async () => {
    const ws = await db.workspace.create({ data: { name: workspaceName() } });
    await db.workspaceMember.createMany({
      data: [
        { workspaceId: ws.id, userId: owner.id, role: 'OWNER' },
        { workspaceId: ws.id, userId: member.id, role: 'MEMBER' },
      ],
    });
    const invite = await call(owner, 'post', `/workspaces/${ws.id}/invitations`, {
      email: invitee.email,
    });
    expect(invite.status).toBe(201);
    const project = await call(owner, 'post', `/workspaces/${ws.id}/projects`, { name: 'P' });
    expect(project.status).toBe(201);
    const projectId = project.body.data.project.id as string;
    const tasksPath = `/workspaces/${ws.id}/projects/${projectId}/tasks`;
    const task = await call(owner, 'post', tasksPath, {
      title: 'T',
      dueDate: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      reminderAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(task.status).toBe(201);
    const taskId = task.body.data.task.id as string;
    expect(
      (await call(owner, 'patch', `${tasksPath}/${taskId}/assignee`, { assigneeId: member.id }))
        .status,
    ).toBe(200);
    expect(
      (await call(member, 'post', `${tasksPath}/${taskId}/comments`, { content: 'Hi' })).status,
    ).toBe(201);
    return { workspaceId: ws.id, projectId, taskId };
  };

  /** Every row that belongs to the workspace, table by table. */
  const census = async ({
    workspaceId,
    projectId,
    taskId,
  }: Awaited<ReturnType<typeof populate>>) => ({
    workspaces: await db.workspace.count({ where: { id: workspaceId } }),
    members: await db.workspaceMember.count({ where: { workspaceId } }),
    invitations: await db.workspaceInvitation.count({ where: { workspaceId } }),
    projects: await db.project.count({ where: { workspaceId } }),
    tasks: await db.task.count({ where: { projectId } }),
    comments: await db.taskComment.count({ where: { taskId } }),
    activities: await db.taskActivity.count({ where: { taskId } }),
    reminders: await db.taskReminder.count({ where: { taskId } }),
    notifications: await db.notification.count({ where: { workspaceId } }),
    notificationsAboutTask: await db.notification.count({ where: { resourceId: taskId } }),
  });

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '6',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
    owner = await signUp('owner');
    member = await signUp('member');
    invitee = await signUp('invitee');
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('deletes the workspace and everything it owns, and nothing else', async () => {
    const doomed = await populate();
    const kept = await populate(); // same users, another workspace
    await call(member, 'patch', '/users/me/settings', { dateFormat: 'ISO' });

    const before = await census(doomed);
    expect(before).toEqual({
      workspaces: 1,
      members: 2,
      invitations: 1,
      projects: 1,
      tasks: 1,
      comments: 1,
      activities: expect.any(Number),
      reminders: 1,
      notifications: 2, // assignment → member, comment → owner
      notificationsAboutTask: 2,
    });
    expect(before.activities).toBeGreaterThanOrEqual(3); // created, assigned, commented
    const keptBefore = await census(kept);
    const sessionsBefore = await db.session.count({
      where: { userId: { in: [owner.id, member.id, invitee.id] } },
    });

    // A member can't, the owner can.
    expect((await call(member, 'delete', `/workspaces/${doomed.workspaceId}`)).status).toBe(403);
    expect(await census(doomed)).toEqual(before);
    const res = await call(owner, 'delete', `/workspaces/${doomed.workspaceId}`);
    expect(res.status).toBe(200);

    expect(await census(doomed)).toEqual({
      workspaces: 0,
      members: 0,
      invitations: 0,
      projects: 0,
      tasks: 0,
      comments: 0,
      activities: 0,
      reminders: 0,
      notifications: 0,
      notificationsAboutTask: 0,
    });
    // The other workspace, the users, their sessions and settings are untouched.
    expect(await census(kept)).toEqual(keptBefore);
    expect(await db.user.count({ where: { id: { in: [owner.id, member.id, invitee.id] } } })).toBe(
      3,
    );
    expect(
      await db.session.count({ where: { userId: { in: [owner.id, member.id, invitee.id] } } }),
    ).toBe(sessionsBefore);
    expect((await db.userSettings.findUnique({ where: { userId: member.id } }))?.dateFormat).toBe(
      'ISO',
    );
    // No orphans anywhere: every child row still points at an existing parent.
    const [orphans] = await db.$queryRaw<{ n: number }[]>`
      SELECT
        (SELECT count(*) FROM workspace_members m
           WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = m.workspace_id))
      + (SELECT count(*) FROM projects p
           WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = p.workspace_id))
      + (SELECT count(*) FROM tasks t
           WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id))
      + (SELECT count(*) FROM notifications n
           WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = n.workspace_id)) AS n`;
    expect(Number(orphans!.n)).toBe(0);

    expect((await call(owner, 'delete', `/workspaces/${doomed.workspaceId}`)).status).toBe(404);
  }, 180_000);

  it('lets exactly one of two concurrent owner deletions succeed', async () => {
    const coOwner = await signUp('coowner');
    const target = await populate();
    await db.workspaceMember.create({
      data: { workspaceId: target.workspaceId, userId: coOwner.id, role: 'OWNER' },
    });
    const results = await Promise.all([
      call(owner, 'delete', `/workspaces/${target.workspaceId}`),
      call(coOwner, 'delete', `/workspaces/${target.workspaceId}`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect((await census(target)).projects).toBe(0);
  }, 180_000);

  it('updates settings with optimistic concurrency', async () => {
    const { workspaceId } = await populate();
    const read = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/settings`)
      .set('Cookie', member.cookie);
    const expectedUpdatedAt = read.body.data.settings.updatedAt as string;
    expect(
      (
        await call(member, 'patch', `/workspaces/${workspaceId}/settings`, {
          name: 'Hijack',
          expectedUpdatedAt,
        })
      ).status,
    ).toBe(403);
    const [first, second] = await Promise.all([
      call(owner, 'patch', `/workspaces/${workspaceId}/settings`, {
        name: `it-${RUN} renamed A`,
        expectedUpdatedAt,
      }),
      call(owner, 'patch', `/workspaces/${workspaceId}/settings`, {
        description: 'B',
        expectedUpdatedAt,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const row = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(row.updatedAt.toISOString() > expectedUpdatedAt).toBe(true);
  }, 120_000);
});
