import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { TaskPriority, TaskStatus } from '../src/modules/tasks/index.js';
import {
  buildTestApp,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
const HOUR = 3_600_000;

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

describe('task search, filtering and sorting', () => {
  let ctx: {
    app: ReturnType<typeof buildTestApp>;
    workspaces: InMemoryWorkspaceRepository;
    tasks: InMemoryTaskRepository;
  };
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;
  let project: string;
  let otherWs: string;
  let foreignProject: string;
  let seq = 0;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const path = (workspaceId = ws, projectId = project) =>
    `/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const list = (
    who: Account,
    query: Record<string, string> = {},
    workspaceId = ws,
    projectId = project,
  ) => request(ctx.app).get(path(workspaceId, projectId)).query(query).set('Cookie', who.cookie);
  const titles = async (query: Record<string, string>, who = member) => {
    const res = await list(who, query);
    expect(res.status).toBe(200);
    return res.body.data.tasks.map((t: { title: string }) => t.title) as string[];
  };
  /** Seeds a task directly with explicit values (createdAt one minute apart). */
  const seed = (
    projectId: string,
    title: string,
    extra: Partial<(typeof ctx.tasks.rows)[number]> = {},
  ) => {
    seq += 1;
    const at = new Date(Date.UTC(2026, 10, 1) + seq * 60_000);
    ctx.tasks.rows.push({
      id: `01a14e7b-cea3-700d-aeda-${String(seq).padStart(12, '0')}`,
      projectId,
      title,
      description: null,
      status: TaskStatus.TODO,
      priority: TaskPriority.MEDIUM,
      createdById: owner.id,
      assigneeId: null,
      assignee: null,
      dueDate: null,
      reminderAt: null,
      createdAt: at,
      updatedAt: at,
      ...extra,
    });
  };

  beforeEach(async () => {
    seq = 0;
    const users = new InMemoryUserRepository();
    const workspaces = new InMemoryWorkspaceRepository(users);
    const projects = new InMemoryProjectRepository(workspaces, users);
    const tasks = new InMemoryTaskRepository(projects, workspaces, users);
    const app = buildTestApp({
      userRepository: users,
      sessionRepository: new InMemorySessionRepository(users),
      workspaceRepository: workspaces,
      projectRepository: projects,
      taskRepository: tasks,
    });
    ctx = { app, workspaces, tasks };
    const signUp = async (email: string): Promise<Account> => {
      const registered = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD });
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD });
      return {
        id: registered.body.data.user.id,
        cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
        csrfToken: login.body.data.csrfToken,
      };
    };
    owner = await signUp('owner@example.com');
    member = await signUp('member@example.com');
    outsider = await signUp('outsider@example.com');
    const newWorkspace = async (by: Account) =>
      (await authed(request(app).post('/api/v1/workspaces'), by).send({ name: 'Team' })).body.data
        .workspace.id as string;
    const newProject = async (by: Account, workspaceId: string) =>
      (
        await authed(request(app).post(`/api/v1/workspaces/${workspaceId}/projects`), by).send({
          name: 'P',
        })
      ).body.data.project.id as string;
    ws = await newWorkspace(owner);
    otherWs = await newWorkspace(outsider);
    workspaces.addMember(ws, member.id);
    project = await newProject(owner, ws);
    foreignProject = await newProject(outsider, otherWs);
  });

  it('searches title and description case-insensitively; empty results are fine', async () => {
    seed(project, 'Login API');
    seed(project, 'Docs', { description: 'Explain the LOGIN flow' });
    seed(project, 'Billing');
    seed(foreignProject, 'login elsewhere');

    expect(await titles({ search: 'login' })).toEqual(['Docs', 'Login API']);
    expect(await titles({ search: '  LoGiN  ' })).toEqual(['Docs', 'Login API']);
    expect(await titles({ search: 'nothing-matches' })).toEqual([]);
    expect(await titles({ search: '   ' })).toHaveLength(3); // blank = no search
  });

  it('filters by status, priority, creator, assignee and unassigned, alone and combined', async () => {
    seed(project, 'A', {
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      assigneeId: member.id,
    });
    seed(project, 'B', {
      status: TaskStatus.TODO,
      priority: TaskPriority.HIGH,
      createdById: member.id,
    });
    seed(project, 'C', {
      status: TaskStatus.IN_PROGRESS,
      priority: TaskPriority.LOW,
      assigneeId: member.id,
    });

    expect(await titles({ status: 'TODO' })).toEqual(['B']);
    expect(await titles({ priority: 'HIGH' })).toEqual(['B', 'A']);
    expect(await titles({ createdById: member.id })).toEqual(['B']);
    expect(await titles({ assigneeId: member.id })).toEqual(['C', 'A']);
    expect(await titles({ assigneeId: member.id.toUpperCase() })).toEqual(['C', 'A']);
    expect(await titles({ unassigned: 'true' })).toEqual(['B']);
    expect(await titles({ unassigned: 'false' })).toHaveLength(3);
    expect(await titles({ priority: 'HIGH', assigneeId: member.id })).toEqual(['A']);
    expect(await titles({ priority: 'HIGH', status: 'DONE', search: 'b' })).toEqual([]);
  });

  it('filters by due date presence, range and overdue (DONE never overdue)', async () => {
    const now = Date.now();
    seed(project, 'Late', { dueDate: new Date(now - 2 * HOUR) });
    seed(project, 'Late but done', { dueDate: new Date(now - 2 * HOUR), status: TaskStatus.DONE });
    seed(project, 'Soon', { dueDate: new Date(now + 5 * HOUR) });
    seed(project, 'Later', { dueDate: new Date(now + 72 * HOUR) });
    seed(project, 'Undated');

    expect(await titles({ overdue: 'true' })).toEqual(['Late']);
    expect(await titles({ dueDate: 'none' })).toEqual(['Undated']);
    expect(await titles({ dueDate: 'any' })).toHaveLength(4);
    expect(
      await titles({
        dueAfter: new Date(now).toISOString(),
        dueBefore: new Date(now + 24 * HOUR).toISOString(),
      }),
    ).toEqual(['Soon']);
    expect(await titles({ dueBefore: new Date(now).toISOString() })).toEqual([
      'Late but done',
      'Late',
    ]);
  });

  it.each([
    ['createdAt', 'asc', ['T1', 'T2', 'T3', 'T4']],
    ['createdAt', 'desc', ['T4', 'T3', 'T2', 'T1']],
    ['updatedAt', 'asc', ['T3', 'T1', 'T4', 'T2']],
    ['updatedAt', 'desc', ['T2', 'T4', 'T1', 'T3']],
    ['dueDate', 'asc', ['T2', 'T4', 'T1', 'T3']], // undated last
    ['dueDate', 'desc', ['T4', 'T2', 'T3', 'T1']], // undated last too
    ['priority', 'asc', ['T3', 'T1', 'T4', 'T2']],
    ['priority', 'desc', ['T2', 'T4', 'T1', 'T3']],
    ['title', 'asc', ['T1', 'T2', 'T3', 'T4']],
    ['title', 'desc', ['T4', 'T3', 'T2', 'T1']],
  ])('sorts by %s %s', async (sortBy, sortOrder, expected) => {
    const t = (h: number) => new Date(Date.UTC(2026, 11, 1) + h * HOUR);
    seed(project, 'T1', { updatedAt: t(2), priority: TaskPriority.MEDIUM });
    seed(project, 'T2', { updatedAt: t(9), dueDate: t(10), priority: TaskPriority.URGENT });
    seed(project, 'T3', { updatedAt: t(1), priority: TaskPriority.LOW });
    seed(project, 'T4', { updatedAt: t(5), dueDate: t(20), priority: TaskPriority.HIGH });
    // Ties broken by id in the sort direction: T1 and T3 have no due date.
    expect(await titles({ sortBy, sortOrder })).toEqual(expected);
  });

  it.each([['dueDate'], ['priority'], ['title'], ['updatedAt']])(
    'pages through every task exactly once when sorted by %s (with ties)',
    async (sortBy) => {
      const priorities = [
        TaskPriority.LOW,
        TaskPriority.HIGH,
        TaskPriority.HIGH,
        TaskPriority.URGENT,
      ];
      for (let i = 0; i < 11; i++) {
        seed(project, `Task ${i % 3}`, {
          priority: priorities[i % 4]!,
          dueDate: i % 3 === 0 ? null : new Date(Date.UTC(2026, 11, 1 + (i % 2))),
          updatedAt: new Date(Date.UTC(2026, 11, 1, i % 2)),
        });
      }
      for (const sortOrder of ['asc', 'desc']) {
        const all = await titles({ sortBy, sortOrder, limit: '50' });
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const res = await list(member, {
            sortBy,
            sortOrder,
            limit: '3',
            ...(cursor && { cursor }),
          });
          expect(res.status).toBe(200);
          ids.push(...res.body.data.tasks.map((t: { id: string }) => t.id));
          cursor = res.body.meta.nextCursor ?? undefined;
        } while (cursor);
        expect(new Set(ids).size).toBe(11);
        const full = (await list(member, { sortBy, sortOrder, limit: '50' })).body.data.tasks.map(
          (t: { id: string }) => t.id,
        );
        expect(ids).toEqual(full);
        expect(all).toHaveLength(11);
      }
    },
  );

  it('pages correctly with filters combined with a sort', async () => {
    for (let i = 0; i < 9; i++) {
      seed(project, `Bug ${i}`, { priority: i % 2 ? TaskPriority.HIGH : TaskPriority.LOW });
      seed(project, `Chore ${i}`);
    }
    const query = { search: 'bug', sortBy: 'priority', sortOrder: 'desc' };
    const first = await list(member, { ...query, limit: '4' });
    expect(first.body.meta.total).toBe(9);
    const second = await list(member, { ...query, limit: '4', cursor: first.body.meta.nextCursor });
    const third = await list(member, { ...query, limit: '4', cursor: second.body.meta.nextCursor });
    expect(second.body.meta.total).toBeUndefined(); // only on the first page
    const got = [...first.body.data.tasks, ...second.body.data.tasks, ...third.body.data.tasks];
    expect(got).toHaveLength(9);
    expect(got.every((t: { title: string }) => t.title.startsWith('Bug'))).toBe(true);
    expect(got.map((t: { priority: string }) => t.priority)).toEqual([
      ...Array(4).fill('HIGH'),
      ...Array(5).fill('LOW'),
    ]);
  });

  it('rejects a cursor reused with a different sort, filter or project', async () => {
    for (let i = 0; i < 4; i++) seed(project, `T${i}`);
    const cursor = (await list(member, { sortBy: 'title', limit: '2' })).body.meta.nextCursor;
    expect((await list(member, { sortBy: 'title', limit: '2', cursor })).status).toBe(200);
    expect((await list(member, { sortBy: 'title', sortOrder: 'asc', cursor })).status).toBe(400);
    expect((await list(member, { sortBy: 'createdAt', cursor })).status).toBe(400);
    expect((await list(member, { sortBy: 'title', status: 'TODO', cursor })).status).toBe(400);
  });

  it.each([
    ['an unsupported sort field', { sortBy: 'assignee' }],
    ['an invalid sort order', { sortOrder: 'up' }],
    ['an invalid status', { status: 'BLOCKED' }],
    ['a lower-case priority', { priority: 'high' }],
    ['a malformed assigneeId', { assigneeId: 'me' }],
    ['a malformed createdById', { createdById: '1' }],
    ['a non-boolean flag', { overdue: 'yes' }],
    ['an invalid dueDate', { dueDate: 'today' }],
    ['a dueAfter without timezone', { dueAfter: '2026-12-01T00:00:00' }],
    ['an empty range', { dueAfter: '2026-12-02T00:00:00Z', dueBefore: '2026-12-01T00:00:00Z' }],
    ['unassigned with an assignee', { unassigned: 'true', assigneeId: UNKNOWN }],
    ['dueDate=none with overdue', { dueDate: 'none', overdue: 'true' }],
    ['a too-long search', { search: 's'.repeat(201) }],
    ['an unknown parameter', { assignee: 'me' }],
  ])('rejects %s with 400', async (_l, query) => {
    const res = await list(member, query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('stays scoped: outsiders and other projects get 404, never other tasks', async () => {
    seed(foreignProject, 'Secret', { priority: TaskPriority.URGENT });
    expect((await list(outsider, { search: 'secret' })).status).toBe(404);
    expect((await list(member, { search: 'secret' }, ws, foreignProject)).status).toBe(404);
    expect(await titles({ search: 'secret', priority: 'URGENT' })).toEqual([]);
  });

  it('keeps archived projects searchable', async () => {
    seed(project, 'Findable');
    await authed(
      request(ctx.app).post(`/api/v1/workspaces/${ws}/projects/${project}/archive`),
      owner,
    );
    expect(await titles({ search: 'find' })).toEqual(['Findable']);
  });

  it('defaults to the previous behaviour: newest first, 20 per page, max 50', async () => {
    for (let i = 0; i < 25; i++) seed(project, `T${i}`);
    const res = await list(member);
    expect(res.body.data.tasks).toHaveLength(20);
    expect(res.body.data.tasks[0].title).toBe('T24');
    expect(res.body.meta.total).toBe(25);
    expect((await list(member, { limit: '51' })).status).toBe(400);
  });
});
