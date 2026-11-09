/**
 * Tasks against the real, isolated test database: persistence of server-decided
 * fields, keyset pagination with project-bound cursors, workspace/project
 * isolation, optimistic concurrency, archived-project rules (including a real
 * concurrent archive), and the project-deletion policy (refused while tasks
 * exist; the database cascade only applies to workspace/project deletion at the
 * database level). Rows are tagged with a per-run email domain / workspace-name
 * prefix and removed afterwards: workspaces (cascading to projects and their
 * tasks), then users.
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
const workspaceName = () => `it-${RUN} tasks ${++counter}`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('tasks with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let raw: pg.Client;
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
  const newProject = async (workspaceId: string, createdById = owner.id) =>
    (await db.project.create({ data: { workspaceId, name: 'Project', createdById } })).id;
  const seed = (projectId: string, createdAts: Date[], prefix = 'T') =>
    db.task.createMany({
      data: createdAts.map((createdAt, i) => ({
        projectId,
        title: `${prefix}${i}`,
        createdById: owner.id,
        createdAt,
      })),
    });

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const base = (ws: string, p: string) => `/api/v1/workspaces/${ws}/projects/${p}/tasks`;
  const create = (who: Account, ws: string, p: string, body: object) =>
    authed(request(app).post(base(ws, p)), who).send(body);
  const list = (who: Account, ws: string, p: string, query: Record<string, string> = {}) =>
    request(app).get(base(ws, p)).query(query).set('Cookie', who.cookie);
  const get = (who: Account, ws: string, p: string, t: string) =>
    request(app)
      .get(`${base(ws, p)}/${t}`)
      .set('Cookie', who.cookie);
  const patch = (who: Account, ws: string, p: string, t: string, body: object) =>
    authed(request(app).patch(`${base(ws, p)}/${t}`), who).send(body);
  const current = (id: string) => db.task.findUnique({ where: { id } });
  const seen = async (id: string) => ({
    expectedUpdatedAt: (await current(id))!.updatedAt.toISOString(),
  });
  const allPages = async (who: Account, ws: string, p: string, limit: number) => {
    const pages: { id: string; title: string; projectId: string }[][] = [];
    let cursor: string | undefined;
    do {
      const res = await list(who, ws, p, { limit: String(limit), ...(cursor && { cursor }) });
      expect(res.status).toBe(200);
      pages.push(res.body.data.tasks);
      cursor = res.body.meta.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  };
  const expectedOrder = async (projectId: string) =>
    (
      await db.task.findMany({
        where: { projectId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
    ).map((t) => t.id);

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
    outsider = await signUp('outsider');
  }, 120_000);

  afterAll(async () => {
    await raw?.end();
    if (!db) return;
    // Workspaces first: cascades to projects and their tasks, which releases
    // the RESTRICT on task and project creators; then the users.
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('creation stores server-decided fields; client overrides and bad input store nothing', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const other = await newProject(ws);

    const res = await create(member, ws, project, {
      title: '  Implement login API ',
      description: 'Create secure login endpoint',
      priority: 'HIGH',
    });
    expect(res.status).toBe(201);
    expect(await current(res.body.data.task.id)).toMatchObject({
      projectId: project,
      createdById: member.id,
      title: 'Implement login API',
      status: 'TODO',
      priority: 'HIGH',
    });
    const byDefault = await create(owner, ws, project, { title: 'Defaults' });
    expect(await current(byDefault.body.data.task.id)).toMatchObject({
      status: 'TODO',
      priority: 'MEDIUM',
      description: null,
      createdById: owner.id,
    });

    const before = await db.task.count({ where: { projectId: { in: [project, other] } } });
    for (const body of [
      { title: 'X', status: 'BLOCKED' }, // a valid status is allowed since Step 24; invalid ones aren't
      { title: 'X', assigneeId: 'not-a-uuid' },
      { title: 'X', projectId: other },
      { title: 'X', createdById: outsider.id },
      { title: 'X', id: randomUUID() },
      { title: 'X', priority: 'CRITICAL' },
      { title: '   ' },
      { title: 't'.repeat(201) },
      { title: 'X', description: 'd'.repeat(5001) },
    ]) {
      expect((await create(owner, ws, project, body)).status).toBe(400);
    }
    expect(await db.task.count({ where: { projectId: { in: [project, other] } } })).toBe(before);
  }, 60_000);

  it('authorization and isolation: outsiders, foreign projects and archived projects store nothing', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const otherWs = await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const foreign = await newProject(otherWs, outsider.id);

    expect((await create(outsider, ws, project, { title: 'X' })).status).toBe(404);
    expect((await create(owner, ws, foreign, { title: 'X' })).status).toBe(404);
    expect((await create(outsider, otherWs, project, { title: 'X' })).status).toBe(404);
    expect((await create(owner, randomUUID(), project, { title: 'X' })).status).toBe(404);

    await db.project.update({ where: { id: project }, data: { status: 'ARCHIVED' } });
    expect((await create(owner, ws, project, { title: 'X' })).status).toBe(409);

    expect(await db.task.count({ where: { projectId: { in: [project, foreign] } } })).toBe(0);
  }, 60_000);

  it('lists with keyset pagination: every task once, in order; limits; project-bound cursors', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const sibling = await newProject(ws);
    const start = Date.UTC(2026, 10, 1);
    await seed(
      project,
      Array.from({ length: 55 }, (_, i) => new Date(start + i * 60_000)),
    );
    await seed(sibling, [new Date(start + 30_000)], 'Sibling');
    const expected = await expectedOrder(project);

    for (const who of [owner, member]) {
      const pages = await allPages(who, ws, project, 20);
      expect(pages.map((p) => p.length)).toEqual([20, 20, 15]);
      const ids = pages.flat().map((t) => t.id);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(55);
      expect(pages.flat().every((t) => t.projectId === project)).toBe(true);
    }
    expect((await list(owner, ws, project)).body.data.tasks).toHaveLength(20);
    expect((await list(owner, ws, project, { limit: '50' })).body.data.tasks).toHaveLength(50);
    expect((await list(owner, ws, project, { limit: '51' })).status).toBe(400);

    // A real cursor from the sibling project is refused, not reinterpreted.
    await seed(sibling, [new Date(start), new Date(start + 1)], 'More');
    const siblingCursor = (await list(owner, ws, sibling, { limit: '1' })).body.meta.nextCursor;
    expect(siblingCursor).toEqual(expect.any(String));
    expect((await list(owner, ws, project, { cursor: siblingCursor })).status).toBe(400);
    expect((await list(owner, ws, project, { cursor: '!!!' })).status).toBe(400);
  }, 120_000);

  it('orders equal timestamps by id DESC with no gaps or repeats', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const project = await newProject(ws);
    const same = new Date(Date.UTC(2026, 10, 2, 8, 0, 0, 321));
    await seed(
      project,
      Array.from({ length: 7 }, () => same),
      'Tie',
    );
    await seed(project, [new Date(same.getTime() + 1), new Date(same.getTime() - 1)], 'Edge');
    const expected = await expectedOrder(project);

    expect((await allPages(owner, ws, project, 2)).flat().map((t) => t.id)).toEqual(expected);
    expect((await allPages(owner, ws, project, 3)).flat().map((t) => t.id)).toEqual(expected);
  }, 60_000);

  it('details and listing: archived readable; cross-project and cross-workspace give 404', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const otherWs = await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const sibling = await newProject(ws);
    const foreign = await newProject(otherWs, outsider.id);
    const task = (await create(owner, ws, project, { title: 'Secret plan', description: 'Steps' }))
      .body.data.task.id;

    const res = await get(member, ws, project, task);
    expect(res.status).toBe(200);
    expect(res.body.data.creator).toEqual({ id: owner.id, email: owner.email });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session|token/i);

    expect((await get(owner, ws, sibling, task)).status).toBe(404);
    expect((await get(outsider, ws, project, task)).status).toBe(404);
    expect((await get(outsider, otherWs, foreign, task)).status).toBe(404);
    expect((await get(outsider, otherWs, project, task)).status).toBe(404);
    expect((await list(outsider, ws, project)).status).toBe(404);
    expect((await list(owner, ws, foreign)).status).toBe(404);

    await db.project.update({ where: { id: project }, data: { status: 'ARCHIVED' } });
    expect((await get(member, ws, project, task)).status).toBe(200);
    expect((await list(member, ws, project)).body.data.tasks).toHaveLength(1);
  }, 60_000);

  it('editing persists every field; updatedAt moves strictly forward; other tasks untouched', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = (await create(owner, ws, project, { title: 'Original' })).body.data.task.id;
    const other = (await create(owner, ws, project, { title: 'Untouched' })).body.data.task.id;
    const untouched = await current(other);
    let last = (await current(task))!.updatedAt.getTime();

    for (const change of [
      { status: 'IN_PROGRESS' },
      { priority: 'URGENT' },
      { title: 'Renamed', description: 'Now described' },
      { status: 'DONE', description: '' },
    ]) {
      const res = await patch(member, ws, project, task, { ...change, ...(await seen(task)) });
      expect(res.status).toBe(200);
      const next = new Date(res.body.data.task.updatedAt).getTime();
      expect(next).toBeGreaterThan(last);
      last = next;
    }
    expect(await current(task)).toMatchObject({
      title: 'Renamed',
      description: null,
      status: 'DONE',
      priority: 'URGENT',
      projectId: project,
      createdById: owner.id,
    });
    expect(await current(other)).toEqual(untouched);

    // Invalid and cross-boundary edits change nothing.
    const before = await current(task);
    for (const body of [
      { status: 'BLOCKED' },
      { priority: 'none' },
      { title: '' },
      { projectId: randomUUID() },
    ]) {
      expect(
        (await patch(owner, ws, project, task, { ...body, ...(await seen(task)) })).status,
      ).toBe(400);
    }
    expect(
      (await patch(outsider, ws, project, task, { title: 'X', ...(await seen(task)) })).status,
    ).toBe(404);
    expect(await current(task)).toEqual(before);
  }, 60_000);

  it('concurrent edits from one version → exactly one wins, the rest get 409', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = (await create(owner, ws, project, { title: 'Contended' })).body.data.task.id;
    const version = await seen(task);

    const results = await Promise.all(
      (['TODO', 'IN_PROGRESS', 'DONE', 'IN_PROGRESS'] as const).map((status, i) =>
        patch(i % 2 ? member : owner, ws, project, task, { status, priority: 'HIGH', ...version }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200)!.body.data.task.status;
    expect((await current(task))!.status).toBe(winner);
  }, 60_000);

  it('a task creation waiting on a concurrent archive sees the archive and creates nothing', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const project = await newProject(ws);

    // Another transaction is archiving the project and holds its row.
    await raw.query('BEGIN');
    await raw.query(`UPDATE projects SET status = 'ARCHIVED' WHERE id = $1`, [project]);
    const pending = create(owner, ws, project, { title: 'Too late' }).then((res) => res);
    await waitForLockWait('%FROM projects%FOR SHARE%');
    await raw.query('COMMIT');

    const res = await pending;
    expect(res.status).toBe(409);
    expect(await db.task.count({ where: { projectId: project } })).toBe(0);
  }, 60_000);

  it('editing tasks of an archived project is refused (409)', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const project = await newProject(ws);
    const task = (await create(owner, ws, project, { title: 'Frozen' })).body.data.task.id;
    await db.project.update({ where: { id: project }, data: { status: 'ARCHIVED' } });
    const before = await current(task);

    expect(
      (await patch(owner, ws, project, task, { status: 'DONE', ...(await seen(task)) })).status,
    ).toBe(409);
    expect(await current(task)).toEqual(before);
  }, 60_000);

  it('project deletion: refused while tasks exist (nothing lost); allowed without tasks', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const withTasks = await newProject(ws);
    const empty = await newProject(ws);
    const task = (await create(owner, ws, withTasks, { title: 'Keep me' })).body.data.task.id;
    const remove = (p: string) =>
      authed(request(app).delete(`/api/v1/workspaces/${ws}/projects/${p}`), owner);

    const refused = await remove(withTasks);
    expect(refused.status).toBe(409);
    expect(await db.project.findUnique({ where: { id: withTasks } })).not.toBeNull();
    expect(await current(task)).not.toBeNull();

    expect((await remove(empty)).status).toBe(200);
    expect(await db.project.findUnique({ where: { id: empty } })).toBeNull();
  }, 60_000);

  it('a task created while a project deletion waits makes the deletion refuse (no silent loss)', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const project = await newProject(ws);

    // A task insert is in flight (uncommitted) and holds a key-share lock on the project.
    await raw.query('BEGIN');
    await raw.query(
      `INSERT INTO tasks (id, project_id, title, created_by_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'In flight', $2, now())`,
      [project, owner.id],
    );
    const pending = authed(
      request(app).delete(`/api/v1/workspaces/${ws}/projects/${project}`),
      owner,
    ).then((res) => res);
    await waitForLockWait('%FROM projects%FOR UPDATE%');
    await raw.query('COMMIT');

    const res = await pending;
    expect(res.status).toBe(409);
    expect(await db.project.findUnique({ where: { id: project } })).not.toBeNull();
    expect(await db.task.count({ where: { projectId: project } })).toBe(1);
  }, 60_000);

  it('database policies: creator RESTRICT; workspace deletion removes its projects and tasks', async () => {
    const creator = await signUp('creator');
    const ws = await workspaceWith([[creator, 'OWNER']]);
    const project = await newProject(ws, creator.id);
    const task = (await create(creator, ws, project, { title: 'Audit me' })).body.data.task.id;

    await db.workspaceMember.deleteMany({ where: { workspaceId: ws, userId: creator.id } });
    await expect(db.user.delete({ where: { id: creator.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect((await current(task))!.createdById).toBe(creator.id);

    await db.workspace.delete({ where: { id: ws } });
    expect(await db.project.findUnique({ where: { id: project } })).toBeNull();
    expect(await current(task)).toBeNull();
  }, 60_000);
});
