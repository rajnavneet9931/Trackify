/**
 * Task comments against the real, isolated test database: persistence, author
 * from the session, permissions (author edits; author or OWNER deletes),
 * hierarchy isolation, archived projects, keyset pagination with task-bound
 * cursors, optimistic concurrency, a demotion racing an owner's delete, and
 * the foreign-key policies (task cascade, author restrict). Rows are tagged
 * with a per-run email domain / workspace-name prefix and removed afterwards.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import {
  assertIsTestDatabase,
  assertTestDatabaseName,
  buildAppWithDatabase,
  testConfig,
} from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} comments ${++counter}`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('task comments with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let raw: pg.Client;
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
  const newTask = async (projectId: string, createdById = owner.id) =>
    (await db.task.create({ data: { projectId, title: 'Task', createdById } })).id;
  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const base = (ws: string, p: string, t: string) =>
    `/api/v1/workspaces/${ws}/projects/${p}/tasks/${t}/comments`;
  const post = (who: Account, ws: string, p: string, t: string, content: string) =>
    authed(request(app).post(base(ws, p, t)), who).send({ content });
  const list = (
    who: Account,
    ws: string,
    p: string,
    t: string,
    query: Record<string, string> = {},
  ) =>
    request(app)
      .get(base(ws, p, t))
      .query(query)
      .set('Cookie', who.cookie);
  const edit = (who: Account, ws: string, p: string, t: string, c: string, body: object) =>
    authed(request(app).patch(`${base(ws, p, t)}/${c}`), who).send(body);
  const remove = (who: Account, ws: string, p: string, t: string, c: string) =>
    authed(request(app).delete(`${base(ws, p, t)}/${c}`), who);
  const current = (id: string) => db.taskComment.findUnique({ where: { id } });
  const seen = async (id: string) => ({
    expectedUpdatedAt: (await current(id))!.updatedAt.toISOString(),
  });
  const seed = (taskId: string, createdAts: Date[], authorId = member.id) =>
    db.taskComment.createMany({
      data: createdAts.map((createdAt, i) => ({
        taskId,
        userId: authorId,
        content: `C${i}`,
        createdAt,
      })),
    });
  const expectedOrder = async (taskId: string) =>
    (
      await db.taskComment.findMany({
        where: { taskId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      })
    ).map((c) => c.id);
  const allPages = async (who: Account, ws: string, p: string, t: string, limit: number) => {
    const pages: { id: string }[][] = [];
    let cursor: string | undefined;
    do {
      const res = await list(who, ws, p, t, { limit: String(limit), ...(cursor && { cursor }) });
      expect(res.status).toBe(200);
      pages.push(res.body.data.comments);
      cursor = res.body.meta.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  };

  /** Polls until a statement matching `pattern` is waiting on a lock. */
  async function waitForLockWait(pattern: string) {
    for (let i = 0; i < 80; i++) {
      const [row] = await db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
      if (row!.waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`no statement matching ${pattern} waited on a lock`);
  }

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '8',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
    raw = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await raw.connect();
    const { rows } = await raw.query<{ name: string }>('SELECT current_database() AS name');
    assertTestDatabaseName(rows[0]!.name);

    owner = await signUp('owner');
    member = await signUp('member');
    colleague = await signUp('colleague');
    outsider = await signUp('outsider');
  }, 120_000);

  afterAll(async () => {
    await raw?.end();
    if (!db) return;
    // Workspaces first: cascades to projects, tasks and comments, which
    // releases the RESTRICT on comment authors; then the users.
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('creates with the session user as author; client overrides and bad content store nothing', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const other = await newTask(project);

    const res = await post(member, ws, project, task, '  Hello team  ');
    expect(res.status).toBe(201);
    expect(await current(res.body.data.comment.id)).toMatchObject({
      taskId: task,
      userId: member.id,
      content: 'Hello team',
    });
    expect(res.body.data.comment.author).toEqual({ id: member.id, email: member.email });

    for (const body of [
      { content: 'x', userId: owner.id },
      { content: 'x', taskId: other },
      { content: '' },
      { content: 'c'.repeat(5001) },
    ]) {
      const bad = await authed(request(app).post(base(ws, project, task)), member).send(body);
      expect(bad.status).toBe(400);
    }
    expect(await db.taskComment.count({ where: { taskId: { in: [task, other] } } })).toBe(1);
    expect((await post(member, ws, project, task, 'c'.repeat(5000))).status).toBe(201);
  }, 60_000);

  it('permissions: author edits; others (even owners) cannot; author or owner deletes', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
      [colleague, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const mine = (await post(member, ws, project, task, 'Mine')).body.data.comment.id;
    const theirs = (await post(colleague, ws, project, task, 'Theirs')).body.data.comment.id;

    expect(
      (await edit(member, ws, project, task, mine, { content: 'Edited', ...(await seen(mine)) }))
        .status,
    ).toBe(200);
    expect((await current(mine))!.content).toBe('Edited');
    expect(
      (await edit(colleague, ws, project, task, mine, { content: 'X', ...(await seen(mine)) }))
        .status,
    ).toBe(403);
    expect(
      (await edit(owner, ws, project, task, mine, { content: 'X', ...(await seen(mine)) })).status,
    ).toBe(403);
    expect((await current(mine))!.content).toBe('Edited');

    expect((await remove(member, ws, project, task, theirs)).status).toBe(403);
    expect(await current(theirs)).not.toBeNull();
    expect((await remove(owner, ws, project, task, theirs)).status).toBe(200);
    expect(await current(theirs)).toBeNull();
    expect((await remove(member, ws, project, task, mine)).status).toBe(200);
    expect(await current(mine)).toBeNull();
    expect((await remove(member, ws, project, task, mine)).status).toBe(404);
  }, 60_000);

  it('isolation: outsiders and cross-hierarchy targets get 404 and change nothing', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const otherWs = await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const sibling = await newTask(project);
    const foreignProject = await newProject(otherWs, outsider.id);
    const foreignTask = await newTask(foreignProject, outsider.id);
    const id = (await post(member, ws, project, task, 'Private')).body.data.comment.id;

    const statuses = [
      (await list(outsider, ws, project, task)).status,
      (await post(outsider, ws, project, task, 'x')).status,
      (await list(owner, ws, project, foreignTask)).status,
      (await post(owner, ws, foreignProject, task, 'x')).status,
      (await edit(owner, ws, project, sibling, id, { content: 'x', ...(await seen(id)) })).status,
      (await remove(owner, ws, project, sibling, id)).status,
      (await remove(outsider, otherWs, foreignProject, foreignTask, id)).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect((await current(id))!.content).toBe('Private');
    expect(
      await db.taskComment.count({ where: { taskId: { in: [task, sibling, foreignTask] } } }),
    ).toBe(1);
  }, 60_000);

  it('archived projects: readable, but no create, edit or delete (409)', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const id = (await post(member, ws, project, task, 'Before archive')).body.data.comment.id;
    await db.project.update({ where: { id: project }, data: { status: 'ARCHIVED' } });

    expect((await list(member, ws, project, task)).body.data.comments).toHaveLength(1);
    expect((await post(member, ws, project, task, 'x')).status).toBe(409);
    expect(
      (await edit(member, ws, project, task, id, { content: 'x', ...(await seen(id)) })).status,
    ).toBe(409);
    expect((await remove(owner, ws, project, task, id)).status).toBe(409);
    expect((await current(id))!.content).toBe('Before archive');
  }, 60_000);

  it('pagination: chronological, every comment once, ties by id, task-bound cursors', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const sibling = await newTask(project);
    const start = Date.UTC(2026, 10, 1);
    const same = new Date(start + 5_000);
    await seed(task, [
      ...Array.from({ length: 21 }, (_, i) => new Date(start + i * 60_000)),
      same,
      same,
      same,
    ]);
    await seed(sibling, [new Date(start), new Date(start + 1)]);
    const expected = await expectedOrder(task);

    for (const limit of [20, 7]) {
      const ids = (await allPages(member, ws, project, task, limit)).flat().map((c) => c.id);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(24);
    }
    expect((await list(member, ws, project, task)).body.data.comments).toHaveLength(20);
    expect(
      (await list(member, ws, project, task, { limit: '50' })).body.data.comments,
    ).toHaveLength(24);
    expect((await list(member, ws, project, task, { limit: '51' })).status).toBe(400);

    const siblingCursor = (await list(member, ws, project, sibling, { limit: '1' })).body.meta
      .nextCursor;
    expect(siblingCursor).toEqual(expect.any(String));
    expect((await list(member, ws, project, task, { cursor: siblingCursor })).status).toBe(400);
  }, 120_000);

  it('concurrent edits from one version: exactly one wins; stale edits get 409', async () => {
    const ws = await workspaceWith([
      [member, 'MEMBER'],
      [owner, 'OWNER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const id = (await post(member, ws, project, task, 'Original')).body.data.comment.id;
    const version = await seen(id);

    const results = await Promise.all(
      ['A', 'B', 'C', 'D'].map((content) =>
        edit(member, ws, project, task, id, { content, ...version }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200)!.body.data.comment.content;
    expect((await current(id))!.content).toBe(winner);
  }, 60_000);

  it('an owner delete waiting on a concurrent demotion sees it (403, comment kept)', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [colleague, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const id = (await post(member, ws, project, task, 'Keep me')).body.data.comment.id;

    await raw.query('BEGIN');
    await raw.query(
      `UPDATE workspace_members SET role = 'MEMBER' WHERE workspace_id = $1 AND user_id = $2`,
      [ws, owner.id],
    );
    const pending = remove(owner, ws, project, task, id).then((res) => res);
    await waitForLockWait('%FROM workspace_members%FOR SHARE%');
    await raw.query('COMMIT');

    expect((await pending).status).toBe(403);
    expect(await current(id)).not.toBeNull();
  }, 60_000);

  it('foreign keys: author RESTRICT; removed author keeps comments (email hidden); task cascade', async () => {
    const author = await signUp('author');
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [author, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const id = (await post(author, ws, project, task, 'Audit trail')).body.data.comment.id;

    await authed(request(app).delete(`/api/v1/workspaces/${ws}/members/${author.id}`), owner);
    const listed = await list(owner, ws, project, task);
    expect(listed.body.data.comments[0]).toMatchObject({ id, authorId: author.id, author: null });
    expect(JSON.stringify(listed.body)).not.toContain(author.email);

    await db.session.deleteMany({ where: { userId: author.id } });
    await expect(db.user.delete({ where: { id: author.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await current(id)).not.toBeNull();

    await db.task.delete({ where: { id: task } });
    expect(await current(id)).toBeNull();
  }, 60_000);

  it('regression: tasks still list, edit and assign normally with comments present', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    await post(member, ws, project, task, 'Discussing');
    const taskPath = `/api/v1/workspaces/${ws}/projects/${project}/tasks/${task}`;
    const updatedAt = (await db.task.findUniqueOrThrow({ where: { id: task } })).updatedAt;

    const edited = await authed(request(app).patch(taskPath), member).send({
      status: 'DONE',
      expectedUpdatedAt: updatedAt.toISOString(),
    });
    expect(edited.status).toBe(200);
    expect(
      (
        await authed(request(app).patch(`${taskPath}/assignee`), member).send({
          assigneeId: member.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get(taskPath).set('Cookie', owner.cookie)).body.data.task,
    ).toMatchObject({
      status: 'DONE',
      assigneeId: member.id,
    });
  }, 60_000);
});
