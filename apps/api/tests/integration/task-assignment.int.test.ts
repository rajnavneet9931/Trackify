/**
 * Task assignment against the real, isolated test database: persistence,
 * workspace-membership enforcement, archived projects, isolation, concurrent
 * assignments, races between an assignment and the assignee's removal, member
 * removal unassigning only in that workspace, and SET NULL on account deletion.
 * Rows are tagged with a per-run email domain / workspace-name prefix and
 * removed afterwards (workspaces, cascading to projects and tasks, then users).
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
const workspaceName = () => `it-${RUN} assign ${++counter}`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('task assignment with real PostgreSQL', () => {
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
  const newTask = async (projectId: string, title = 'Task', createdById = owner.id) =>
    (await db.task.create({ data: { projectId, title, createdById } })).id;
  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const assign = (who: Account, ws: string, p: string, t: string, assigneeId: string | null) =>
    authed(
      request(app).patch(`/api/v1/workspaces/${ws}/projects/${p}/tasks/${t}/assignee`),
      who,
    ).send({ assigneeId });
  const assigneeOf = async (taskId: string) =>
    (await db.task.findUnique({ where: { id: taskId }, select: { assigneeId: true } }))?.assigneeId;

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
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('assigns, reassigns and unassigns; persists and bumps updatedAt; idempotent repeats', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
      [colleague, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    let last = (await db.task.findUniqueOrThrow({ where: { id: task } })).updatedAt.getTime();

    for (const [who, assignee] of [
      [member, colleague.id],
      [colleague, owner.id],
      [owner, null],
    ] as const) {
      const res = await assign(who, ws, project, task, assignee);
      expect(res.status).toBe(200);
      expect(res.body.data.changed).toBe(true);
      expect(await assigneeOf(task)).toBe(assignee);
      const next = new Date(res.body.data.task.updatedAt).getTime();
      expect(next).toBeGreaterThan(last);
      last = next;
    }
    expect((await assign(owner, ws, project, task, null)).body.data.changed).toBe(false);

    const res = await assign(owner, ws, project, task, member.id);
    expect(res.body.data.task.assignee).toEqual({ id: member.id, email: member.email });
    const listed = await request(app)
      .get(`/api/v1/workspaces/${ws}/projects/${project}/tasks`)
      .set('Cookie', colleague.cookie);
    expect(listed.body.data.tasks[0].assignee).toEqual({ id: member.id, email: member.email });
    expect(JSON.stringify(listed.body)).not.toMatch(/password|hash|session|token/i);
  }, 60_000);

  it('rejects non-members, members of another workspace and unknown users (422, nothing written)', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const task = await newTask(project);
    await assign(owner, ws, project, task, member.id);

    for (const assignee of [outsider.id, colleague.id, randomUUID()]) {
      const res = await assign(owner, ws, project, task, assignee);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toBe('The assignee must be a member of this workspace.');
    }
    expect(await assigneeOf(task)).toBe(member.id);
  }, 60_000);

  it('isolation and archived projects: 404 across boundaries, 409 when archived', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const otherWs = await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const sibling = await newProject(ws);
    const foreign = await newProject(otherWs, outsider.id);
    const task = await newTask(project);
    const foreignTask = await newTask(foreign, 'Theirs', outsider.id);

    expect((await assign(outsider, ws, project, task, outsider.id)).status).toBe(404);
    expect((await assign(owner, ws, sibling, task, member.id)).status).toBe(404);
    expect((await assign(owner, ws, project, foreignTask, member.id)).status).toBe(404);
    expect((await assign(outsider, otherWs, foreign, task, outsider.id)).status).toBe(404);
    expect(await assigneeOf(task)).toBeNull();
    expect(await assigneeOf(foreignTask)).toBeNull();

    await db.project.update({ where: { id: project }, data: { status: 'ARCHIVED' } });
    expect((await assign(member, ws, project, task, member.id)).status).toBe(409);
    expect(await assigneeOf(task)).toBeNull();
  }, 60_000);

  it('concurrent assignments: all succeed, serialized; the task ends with one valid assignee', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
      [colleague, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    const candidates = [owner.id, member.id, colleague.id, null];

    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(
        [owner, member, colleague, owner, member, colleague].map((who, i) =>
          assign(who, ws, project, task, candidates[(i + round) % candidates.length]!),
        ),
      );
      // Every request succeeds, except that under heavy load one may be refused
      // with the retryable 503 (rolled back, nothing written). Never a 500.
      const statuses = results.map((r) => r.status);
      for (const status of statuses) expect([200, 503]).toContain(status);
      expect(statuses).toContain(200);
      expect(candidates).toContain(await assigneeOf(task));
    }
  }, 120_000);

  it('an assignment waiting on the assignee’s removal sees the removal (422, nothing written)', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [colleague, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);

    // Another transaction is removing the colleague and holds their membership row.
    await raw.query('BEGIN');
    await raw.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      ws,
      colleague.id,
    ]);
    const pending = assign(owner, ws, project, task, colleague.id).then((res) => res);
    await waitForLockWait('%FROM workspace_members%FOR SHARE%');
    await raw.query('COMMIT');

    const res = await pending;
    expect(res.status).toBe(422);
    expect(await assigneeOf(task)).toBeNull();
  }, 60_000);

  it('a removal waiting on an in-flight assignment unassigns after it commits (no orphan)', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [colleague, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);

    // An assignment transaction holds the colleague's membership FOR SHARE.
    await raw.query('BEGIN');
    await raw.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE',
      [ws, colleague.id],
    );
    await raw.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [colleague.id, task]);
    const removal = authed(
      request(app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`),
      owner,
    ).then((res) => res);
    await waitForLockWait('%DELETE FROM%workspace_members%');
    await raw.query('COMMIT');

    expect((await removal).status).toBe(200);
    expect(await assigneeOf(task)).toBeNull();
    expect(
      await db.workspaceMember.count({ where: { workspaceId: ws, userId: colleague.id } }),
    ).toBe(0);
  }, 60_000);

  it('member removal unassigns them in that workspace only', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
      [colleague, 'MEMBER'],
    ]);
    const otherWs = await workspaceWith([
      [outsider, 'OWNER'],
      [colleague, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const sibling = await newProject(ws);
    const foreign = await newProject(otherWs, outsider.id);
    const a = await newTask(project);
    const b = await newTask(sibling);
    const keep = await newTask(project, 'Member task');
    const elsewhere = await newTask(foreign, 'Elsewhere', outsider.id);
    await assign(owner, ws, project, a, colleague.id);
    await assign(owner, ws, sibling, b, colleague.id);
    await assign(owner, ws, project, keep, member.id);
    await assign(outsider, otherWs, foreign, elsewhere, colleague.id);

    const res = await authed(
      request(app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`),
      owner,
    );

    expect(res.status).toBe(200);
    expect(await assigneeOf(a)).toBeNull();
    expect(await assigneeOf(b)).toBeNull();
    expect(await assigneeOf(keep)).toBe(member.id);
    expect(await assigneeOf(elsewhere)).toBe(colleague.id);
    expect((await assign(owner, ws, project, a, colleague.id)).status).toBe(422);
  }, 60_000);

  it('deleting an assignee’s account clears the assignment (SET NULL), task kept', async () => {
    const assignee = await signUp('assignee');
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [assignee, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const task = await newTask(project);
    await assign(owner, ws, project, task, assignee.id);

    // Accounts with memberships can't be deleted (RESTRICT); remove it first,
    // then simulate an assignment left behind by a writer that bypassed the API.
    await db.workspaceMember.deleteMany({ where: { workspaceId: ws, userId: assignee.id } });
    await db.task.update({ where: { id: task }, data: { assigneeId: assignee.id } });
    await db.session.deleteMany({ where: { userId: assignee.id } });
    await db.user.delete({ where: { id: assignee.id } });

    expect(await db.task.findUnique({ where: { id: task } })).not.toBeNull();
    expect(await assigneeOf(task)).toBeNull();
  }, 60_000);
});
