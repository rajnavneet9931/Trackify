/**
 * Task activity history against the real, isolated test database: entries
 * written in the same transaction as their operations (and rolled back with
 * them), no entries for failed or no-op operations, correct actors, member
 * removal unassignments, chronological task-bound pagination, isolation, and
 * the foreign-key policies (task cascade, actor SET NULL). Rows are tagged
 * with a per-run email domain / workspace-name prefix and removed afterwards.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { PrismaTaskRepository } from '../../src/modules/tasks/index.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} activity ${++counter}`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('task activity with real PostgreSQL', () => {
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
  const newProject = async (workspaceId: string, createdById = owner.id) =>
    (await db.project.create({ data: { workspaceId, name: 'Project', createdById } })).id;
  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const tasksPath = (ws: string, p: string) => `/api/v1/workspaces/${ws}/projects/${p}/tasks`;
  const createTask = async (
    who: Account,
    ws: string,
    p: string,
    body: object = { title: 'Task' },
  ) =>
    (await authed(request(app).post(tasksPath(ws, p)), who).send(body)).body.data.task as {
      id: string;
    };
  const version = async (taskId: string) => ({
    expectedUpdatedAt: (
      await db.task.findUniqueOrThrow({ where: { id: taskId } })
    ).updatedAt.toISOString(),
  });
  const editTask = async (who: Account, ws: string, p: string, taskId: string, body: object) =>
    authed(request(app).patch(`${tasksPath(ws, p)}/${taskId}`), who).send({
      ...(await version(taskId)),
      ...body,
    });
  const stored = (taskId: string) =>
    db.taskActivity.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { type: true, userId: true, metadata: true },
    });
  const list = (
    who: Account,
    ws: string,
    p: string,
    t: string,
    query: Record<string, string> = {},
  ) =>
    request(app)
      .get(`${tasksPath(ws, p)}/${t}/activities`)
      .query(query)
      .set('Cookie', who.cookie);

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
    // Workspaces first: cascades to projects, tasks, comments and activities.
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('persists every event type with the right actor and safe metadata', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
      [colleague, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await createTask(member, ws, project, { title: 'Login', priority: 'HIGH' });
    await editTask(owner, ws, project, task.id, {
      title: 'Login v2',
      description: 'Private notes',
      status: 'IN_PROGRESS',
      priority: 'URGENT',
    });
    await authed(request(app).patch(`${tasksPath(ws, project)}/${task.id}/assignee`), member).send({
      assigneeId: colleague.id,
    });
    const comment = (
      await authed(
        request(app).post(`${tasksPath(ws, project)}/${task.id}/comments`),
        colleague,
      ).send({
        content: 'Sensitive remark',
      })
    ).body.data.comment;
    await authed(
      request(app).patch(`${tasksPath(ws, project)}/${task.id}/comments/${comment.id}`),
      colleague,
    ).send({ content: 'Sensitive remark 2', expectedUpdatedAt: comment.updatedAt });
    await authed(
      request(app).delete(`${tasksPath(ws, project)}/${task.id}/comments/${comment.id}`),
      owner,
    );

    const rows = await stored(task.id);
    expect(rows.map((r) => [r.type, r.userId])).toEqual([
      ['TASK_CREATED', member.id],
      ['TASK_UPDATED', owner.id],
      ['STATUS_CHANGED', owner.id],
      ['PRIORITY_CHANGED', owner.id],
      ['ASSIGNEE_CHANGED', member.id],
      ['COMMENT_ADDED', colleague.id],
      ['COMMENT_EDITED', colleague.id],
      ['COMMENT_DELETED', owner.id],
    ]);
    expect(rows[1]!.metadata).toEqual({
      changedFields: ['title', 'description'],
      title: { from: 'Login', to: 'Login v2' },
    });
    expect(rows[2]!.metadata).toEqual({ from: 'TODO', to: 'IN_PROGRESS' });
    expect(rows[4]!.metadata).toEqual({ from: null, to: colleague.id });
    expect(rows[5]!.metadata).toEqual({ commentId: comment.id });
    expect(JSON.stringify(rows)).not.toMatch(/Private notes|Sensitive remark/);

    const res = await list(owner, ws, project, task.id);
    expect(res.body.data.activities.map((a: { type: string }) => a.type)).toEqual(
      rows.map((r) => r.type),
    );
  }, 90_000);

  it('records nothing for failed, rejected or no-op operations', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await createTask(member, ws, project, { title: 'Same' });

    const responses = [
      await authed(request(app).patch(`${tasksPath(ws, project)}/${task.id}`), member).send({
        status: 'DONE',
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
      await authed(
        request(app).patch(`${tasksPath(ws, project)}/${task.id}/assignee`),
        member,
      ).send({
        assigneeId: outsider.id,
      }),
      await editTask(member, ws, project, task.id, { title: 'Same', status: 'TODO' }),
      await authed(
        request(app).patch(`${tasksPath(ws, project)}/${task.id}/assignee`),
        member,
      ).send({
        assigneeId: null,
      }),
    ];
    expect(responses.map((r) => r.status)).toEqual([409, 422, 200, 200]);
    expect((await stored(task.id)).map((r) => r.type)).toEqual(['TASK_CREATED']);
  }, 60_000);

  it('is atomic: an activity written in a transaction that fails is rolled back with it', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    const task = await createTask(member, ws, project);
    const repo = new PrismaTaskRepository(db);
    const before = await db.task.findUniqueOrThrow({ where: { id: task.id } });

    await expect(
      repo.withProjectLock(ws, project, member.id, async (scope) => {
        await scope.update(task.id, before.updatedAt, { status: 'DONE' });
        await scope.record(task.id, {
          type: 'STATUS_CHANGED',
          metadata: { from: 'TODO', to: 'DONE' },
        });
        throw new Error('fail after writing');
      }),
    ).rejects.toThrow('fail after writing');

    expect((await stored(task.id)).map((r) => r.type)).toEqual(['TASK_CREATED']);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('TODO');

    // Invalid metadata is refused and rolls the operation back too.
    await expect(
      repo.withProjectLock(ws, project, member.id, (scope) =>
        scope.record(task.id, { type: 'COMMENT_ADDED', metadata: { commentId: 'x' } as never }),
      ),
    ).rejects.toThrow();
    expect(await stored(task.id)).toHaveLength(1);
  }, 60_000);

  it('concurrent edits from one version produce exactly one set of entries', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await createTask(member, ws, project);
    const v = await version(task.id);

    const results = await Promise.all(
      (['IN_PROGRESS', 'DONE', 'IN_PROGRESS', 'DONE'] as const).map((status, i) =>
        authed(
          request(app).patch(`${tasksPath(ws, project)}/${task.id}`),
          i % 2 ? member : owner,
        ).send({
          status,
          ...v,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200)!.body.data.task.status;
    const rows = await stored(task.id);
    expect(rows.map((r) => r.type)).toEqual(['TASK_CREATED', 'STATUS_CHANGED']);
    expect(rows[1]!.metadata).toEqual({ from: 'TODO', to: winner });
  }, 60_000);

  it('member removal records each unassignment in that workspace, attributed to the remover', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [colleague, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const a = await createTask(owner, ws, project);
    const b = await createTask(owner, ws, project);
    for (const t of [a, b]) {
      await authed(request(app).patch(`${tasksPath(ws, project)}/${t.id}/assignee`), owner).send({
        assigneeId: colleague.id,
      });
    }

    await authed(request(app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`), owner);

    for (const t of [a, b]) {
      const last = (await stored(t.id)).at(-1)!;
      expect(last).toEqual({
        type: 'ASSIGNEE_CHANGED',
        userId: owner.id,
        metadata: { from: colleague.id, to: null, reason: 'MEMBER_REMOVED' },
      });
    }
    const res = await list(owner, ws, project, a.id);
    expect(res.body.data.activities.at(-1).details).toEqual({
      type: 'ASSIGNEE_CHANGED',
      from: { id: colleague.id, email: null },
      to: null,
      reason: 'MEMBER_REMOVED',
    });
  }, 60_000);

  it('paginates chronologically with task-bound cursors; isolated across workspaces', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const otherWs = await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const foreignProject = await newProject(otherWs, outsider.id);
    const task = await createTask(member, ws, project);
    const sibling = await createTask(member, ws, project);
    const foreignTask = await createTask(outsider, otherWs, foreignProject);
    const base = Date.UTC(2026, 10, 1);
    await db.taskActivity.createMany({
      data: Array.from({ length: 24 }, (_, i) => ({
        taskId: task.id,
        userId: member.id,
        type: 'COMMENT_ADDED' as const,
        metadata: { commentId: randomUUID() },
        createdAt: new Date(base + (i < 4 ? 0 : i) * 1000), // four share a timestamp
      })),
    });
    await db.taskActivity.create({
      data: {
        taskId: sibling.id,
        userId: member.id,
        type: 'COMMENT_ADDED',
        metadata: { commentId: randomUUID() },
        createdAt: new Date(base),
      },
    });
    const expected = (
      await db.taskActivity.findMany({
        where: { taskId: task.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      })
    ).map((r) => r.id);

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await list(member, ws, project, task.id, {
        limit: '7',
        ...(cursor && { cursor }),
      });
      expect(res.status).toBe(200);
      ids.push(...res.body.data.activities.map((a: { id: string }) => a.id));
      cursor = res.body.meta.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(25);

    const siblingCursor = (await list(member, ws, project, sibling.id, { limit: '1' })).body.meta
      .nextCursor;
    expect((await list(member, ws, project, task.id, { cursor: siblingCursor })).status).toBe(400);
    expect((await list(outsider, ws, project, task.id)).status).toBe(404);
    expect((await list(member, ws, project, foreignTask.id)).status).toBe(404);
    expect((await list(outsider, otherWs, foreignProject, task.id)).status).toBe(404);
  }, 90_000);

  it('archived projects keep their history readable', async () => {
    const ws = await workspaceWith([[member, 'MEMBER']]);
    const project = await newProject(ws);
    const task = await createTask(member, ws, project);
    await db.project.update({ where: { id: project }, data: { status: 'ARCHIVED' } });
    const res = await list(member, ws, project, task.id);
    expect(res.status).toBe(200);
    expect(res.body.data.activities).toHaveLength(1);
  }, 60_000);

  it('deleting the actor keeps the history (actor cleared); deleting the task removes it', async () => {
    const actor = await signUp('actor');
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [actor, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = (
      await db.task.create({ data: { projectId: project, title: 'T', createdById: owner.id } })
    ).id;
    await db.taskActivity.create({
      data: {
        taskId: task,
        userId: actor.id,
        type: 'STATUS_CHANGED',
        metadata: { from: 'TODO', to: 'DONE' },
      },
    });

    // An account can only be deleted once it has no memberships and sessions.
    await db.workspaceMember.deleteMany({ where: { userId: actor.id } });
    await db.session.deleteMany({ where: { userId: actor.id } });
    await db.user.delete({ where: { id: actor.id } });

    const rows = await stored(task);
    expect(rows).toEqual([
      { type: 'STATUS_CHANGED', userId: null, metadata: { from: 'TODO', to: 'DONE' } },
    ]);
    const res = await list(owner, ws, project, task);
    expect(res.body.data.activities[0]).toMatchObject({ actorId: null, actor: null });

    await db.task.delete({ where: { id: task } });
    expect(await db.taskActivity.count({ where: { taskId: task } })).toBe(0);
  }, 60_000);
});
