import { Writable } from 'node:stream';

import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { encodeTaskCursor } from '../src/modules/tasks/task-cursor.js';
import { TaskPriority, TaskStatus } from '../src/modules/tasks/index.js';
import {
  buildTestApp,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableProjectRepository,
  unreachableTaskRepository,
  unreachableWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
const TASK_FIELDS = [
  'assignee',
  'assigneeId',
  'createdAt',
  'createdById',
  'description',
  'dueDate',
  'id',
  'priority',
  'projectId',
  'reminderAt',
  'status',
  'title',
  'updatedAt',
];

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

async function setup(failing = false, logs?: { text: string }) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const workspaces = new InMemoryWorkspaceRepository(users);
  const projects = new InMemoryProjectRepository(workspaces, users);
  const tasks = new InMemoryTaskRepository(projects, workspaces, users);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
    projectRepository: failing ? unreachableProjectRepository : projects,
    taskRepository: failing ? unreachableTaskRepository : tasks,
    ...(logs && {
      logger: pino(
        { level: 'trace' },
        new Writable({
          write(chunk, _encoding, done) {
            logs.text += chunk.toString();
            done();
          },
        }),
      ),
    }),
  });
  const signUp = async (email: string): Promise<Account> => {
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
  return { app, sessions, workspaces, projects, tasks, signUp };
}

describe('tasks API', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;
  let project: string;
  let sibling: string; // another project, same workspace
  let otherWs: string;
  let foreignProject: string; // a project in another workspace

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const tasksPath = (workspaceId = ws, projectId = project) =>
    `/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const create = (who: Account, body: object, workspaceId = ws, projectId = project) =>
    authed(request(ctx.app).post(tasksPath(workspaceId, projectId)), who).send(body);
  const list = (
    who: Account,
    query: Record<string, string> = {},
    workspaceId = ws,
    projectId = project,
  ) =>
    request(ctx.app).get(tasksPath(workspaceId, projectId)).query(query).set('Cookie', who.cookie);
  const get = (who: Account, taskId: string, workspaceId = ws, projectId = project) =>
    request(ctx.app)
      .get(`${tasksPath(workspaceId, projectId)}/${taskId}`)
      .set('Cookie', who.cookie);
  const patch = (
    who: Account,
    taskId: string,
    body: object,
    workspaceId = ws,
    projectId = project,
  ) =>
    authed(request(ctx.app).patch(`${tasksPath(workspaceId, projectId)}/${taskId}`), who).send(
      body,
    );
  const row = (id: string) => ctx.tasks.rows.find((t) => t.id === id);
  const seen = (id: string) => ({ expectedUpdatedAt: row(id)!.updatedAt.toISOString() });
  const archive = (projectId = project) =>
    authed(request(ctx.app).post(`/api/v1/workspaces/${ws}/projects/${projectId}/archive`), owner);

  /** Seeds `count` tasks in a project, one second apart (newest last). */
  const seed = (projectId: string, count: number, start = Date.UTC(2026, 10, 1)) => {
    for (let i = 0; i < count; i++) {
      const at = new Date(start + i * 1000);
      ctx.tasks.rows.push({
        id: `01a14e7b-cea3-700d-aeda-${String(ctx.tasks.rows.length + 100).padStart(12, '0')}`,
        projectId,
        title: `Task ${i}`,
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
      });
    }
  };
  const allPages = async (who: Account, limit: number, projectId = project) => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const res = await list(
        who,
        { limit: String(limit), ...(cursor && { cursor }) },
        ws,
        projectId,
      );
      expect(res.status).toBe(200);
      pages.push(res.body.data.tasks.map((t: { id: string }) => t.id));
      cursor = res.body.meta.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  };

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    const newWorkspace = async (by: Account) =>
      (await authed(request(ctx.app).post('/api/v1/workspaces'), by).send({ name: 'Team' })).body
        .data.workspace.id as string;
    const newProject = async (by: Account, workspaceId: string, name: string) =>
      (
        await authed(request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects`), by).send({
          name,
        })
      ).body.data.project.id as string;
    ws = await newWorkspace(owner);
    otherWs = await newWorkspace(outsider);
    ctx.workspaces.addMember(ws, member.id);
    project = await newProject(owner, ws, 'Website');
    sibling = await newProject(owner, ws, 'Mobile');
    foreignProject = await newProject(outsider, otherWs, 'Theirs');
  });

  describe('POST (create)', () => {
    it.each([
      ['the owner', () => owner],
      ['a regular member', () => member],
    ])(
      'lets %s create a task: TODO, MEDIUM, project from the URL, creator from the session',
      async (_l, who) => {
        const res = await create(who(), {
          title: '  Implement login API  ',
          description: '  Create secure login endpoint ',
        });

        expect(res.status).toBe(201);
        expect(Object.keys(res.body.data.task).sort()).toEqual(TASK_FIELDS);
        expect(res.body.data.task).toMatchObject({
          projectId: project,
          title: 'Implement login API',
          description: 'Create secure login endpoint',
          status: 'TODO',
          priority: 'MEDIUM',
          createdById: who().id,
        });
        expect(row(res.body.data.task.id)).toMatchObject({
          projectId: project,
          createdById: who().id,
        });
      },
    );

    it.each([['LOW'], ['MEDIUM'], ['HIGH'], ['URGENT']])(
      'persists priority %s',
      async (priority) => {
        const res = await create(member, { title: 'T', priority });
        expect(res.status).toBe(201);
        expect(row(res.body.data.task.id)!.priority).toBe(priority);
      },
    );

    it.each([
      ['missing', {}],
      ['null', { description: null }],
      ['empty', { description: '' }],
      ['blank', { description: ' \n ' }],
    ])('stores a %s description as null', async (_l, extra) => {
      const res = await create(owner, { title: 'T', ...extra });
      expect(res.status).toBe(201);
      expect(res.body.data.task.description).toBeNull();
    });

    it('accepts the length boundaries', async () => {
      const res = await create(owner, { title: 't'.repeat(200), description: 'd'.repeat(5000) });
      expect(res.status).toBe(201);
    });

    it.each([
      ['a missing title', {}],
      ['an empty title', { title: '' }],
      ['a whitespace-only title', { title: '   ' }],
      ['a title over 200 characters', { title: 't'.repeat(201) }],
      ['a title with control characters', { title: 'a\nb' }],
      ['a description over 5000 characters', { title: 'T', description: 'd'.repeat(5001) }],
      ['an invalid priority', { title: 'T', priority: 'CRITICAL' }],
      ['a lower-case priority', { title: 'T', priority: 'high' }],
      ['an invalid status', { title: 'T', status: 'BLOCKED' }],
      ['a lower-case status', { title: 'T', status: 'done' }],
      ['a malformed assigneeId', { title: 'T', assigneeId: 'not-a-uuid' }],
      ['a client id', { title: 'T', id: UNKNOWN }],
      ['a client projectId', { title: 'T', projectId: UNKNOWN }],
      ['a client createdById', { title: 'T', createdById: UNKNOWN }],
      ['an unknown field', { title: 'T', assignee: UNKNOWN }],
    ])('rejects %s with 400 and stores nothing', async (_l, body) => {
      const res = await create(owner, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(ctx.tasks.rows).toHaveLength(0);
    });

    it('refuses archived projects with 409', async () => {
      await archive();
      const res = await create(member, { title: 'T' });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(
        'This project is archived. Its tasks are read-only until it is restored.',
      );
      expect(ctx.tasks.rows).toHaveLength(0);
    });

    it('answers outsiders, unknown workspaces, unknown and foreign projects with 404', async () => {
      const results = [
        await create(outsider, { title: 'T' }),
        await create(owner, { title: 'T' }, UNKNOWN),
        await create(owner, { title: 'T' }, ws, UNKNOWN),
        await create(owner, { title: 'T' }, ws, foreignProject), // project of another workspace
        await create(outsider, { title: 'T' }, otherWs, project), // own workspace, foreign project
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
      expect({ ...results[0]!.body.error, requestId: 0 }).toEqual({
        ...results[1]!.body.error,
        requestId: 0,
      });
      expect(ctx.tasks.rows).toHaveLength(0);
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await authed(request(ctx.app).post(tasksPath()), owner)
        .type('form')
        .send('title=T');
      expect(res.status).toBe(415);
    });
  });

  describe('GET (list)', () => {
    it.each([
      ['the owner', () => owner],
      ['a regular member', () => member],
    ])('lets %s list a project’s tasks, newest first, safe fields only', async (_l, who) => {
      seed(project, 3);
      seed(sibling, 2);

      const res = await list(who());

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.meta).toEqual({ limit: 20, nextCursor: null, total: 3 });
      expect(res.body.data.tasks.map((t: { title: string }) => t.title)).toEqual([
        'Task 2',
        'Task 1',
        'Task 0',
      ]);
      for (const task of res.body.data.tasks) {
        expect(Object.keys(task).sort()).toEqual(TASK_FIELDS);
        expect(task.projectId).toBe(project);
      }
    });

    it('returns an empty list for a project without tasks', async () => {
      const res = await list(owner);
      expect(res.body).toEqual({
        data: { tasks: [] },
        meta: { limit: 20, nextCursor: null, total: 0 },
      });
    });

    it('keeps archived projects’ tasks readable', async () => {
      seed(project, 2);
      await archive();
      const res = await list(member);
      expect(res.status).toBe(200);
      expect(res.body.data.tasks).toHaveLength(2);
    });

    it('answers outsiders, unknown and foreign projects with 404', async () => {
      seed(foreignProject, 2);
      const results = [
        await list(outsider),
        await list(owner, {}, UNKNOWN),
        await list(owner, {}, ws, UNKNOWN),
        await list(owner, {}, ws, foreignProject),
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404]);
      expect(JSON.stringify(results.map((r) => r.body))).not.toContain('Task 0');
    });

    it('defaults to 20 per page and allows at most 50', async () => {
      seed(project, 60);
      const byDefault = await list(owner);
      expect(byDefault.body.data.tasks).toHaveLength(20);
      expect(byDefault.body.meta.nextCursor).toEqual(expect.any(String));
      expect((await list(owner, { limit: '50' })).body.data.tasks).toHaveLength(50);
    });

    it.each([['0'], ['51'], ['-1'], ['2.5'], ['x'], ['']])('rejects limit=%j', async (limit) => {
      expect((await list(owner, { limit })).status).toBe(400);
    });

    it('pages through every task exactly once, in order', async () => {
      seed(project, 7);
      const pages = await allPages(owner, 3);
      expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
      expect(pages.flat()).toEqual([...ctx.tasks.rows].reverse().map((t) => t.id));
      expect(new Set(pages.flat()).size).toBe(7);
    });

    it('orders equal timestamps by id DESC deterministically', async () => {
      for (let i = 0; i < 5; i++) seed(project, 1, Date.UTC(2026, 10, 2));
      const first = await allPages(owner, 2);
      expect(first.flat()).toEqual(
        ctx.tasks.rows
          .map((t) => t.id)
          .sort()
          .reverse(),
      );
      expect(await allPages(owner, 2)).toEqual(first);
    });

    it('rejects a cursor issued for another project (400)', async () => {
      seed(project, 3);
      seed(sibling, 3);
      const fromSibling = (await list(owner, { limit: '1' }, ws, sibling)).body.meta.nextCursor;
      const res = await list(owner, { cursor: fromSibling });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Invalid pagination cursor');
    });

    it.each([
      ['not base64url', '!!!'],
      ['a project cursor', Buffer.from(`p1:1761955200000|${UNKNOWN}`).toString('base64url')],
      ['a bad timestamp', () => Buffer.from(`t1:${project}|soon|${UNKNOWN}`).toString('base64url')],
      ['a bad id', () => Buffer.from(`t1:${project}|1761955200000|nope`).toString('base64url')],
      ['extra parts', () => Buffer.from(`t1:${project}|1|${UNKNOWN}|x`).toString('base64url')],
      ['an over-long value', 'a'.repeat(301)],
    ])('rejects a malformed cursor: %s', async (_l, cursor) => {
      const value = typeof cursor === 'function' ? cursor() : cursor;
      expect((await list(owner, { cursor: value })).status).toBe(400);
    });

    it('rejects a tampered cursor (edited bytes)', async () => {
      seed(project, 3);
      const valid = (await list(owner, { limit: '1' })).body.meta.nextCursor as string;
      expect((await list(owner, { cursor: `${valid.slice(0, -3)}AAA` })).status).toBe(400);
    });

    it('accepts a well-formed cursor bound to this project', async () => {
      seed(project, 3);
      const cursor = encodeTaskCursor(project, {
        createdAt: new Date(Date.UTC(2026, 10, 1) + 1500),
        id: UNKNOWN,
      });
      const res = await list(owner, { cursor });
      expect(res.body.data.tasks.map((t: { title: string }) => t.title)).toEqual([
        'Task 1',
        'Task 0',
      ]);
    });

    it('shows a newly created task first', async () => {
      seed(project, 2);
      const created = await create(member, { title: 'Brand new' });
      expect((await list(owner)).body.data.tasks[0].id).toBe(created.body.data.task.id);
    });
  });

  describe('GET (details)', () => {
    let taskId: string;
    beforeEach(async () => {
      taskId = (await create(owner, { title: 'Details', description: 'Full text' })).body.data.task
        .id;
    });

    it.each([
      ['the owner', () => owner],
      ['a regular member', () => member],
    ])('lets %s view a task with its creator and safe fields only', async (_l, who) => {
      const res = await get(who(), taskId);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(['creator', 'reminder', 'task']);
      expect(Object.keys(res.body.data.task).sort()).toEqual(TASK_FIELDS);
      expect(res.body.data.task).toMatchObject({
        id: taskId,
        title: 'Details',
        description: 'Full text',
      });
      expect(res.body.data.creator).toEqual({ id: owner.id, email: 'owner@example.com' });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session|token/i);
    });

    it('keeps tasks of archived projects viewable', async () => {
      await archive();
      expect((await get(member, taskId)).status).toBe(200);
    });

    it('answers outsiders, unknown tasks, other projects and other workspaces with 404', async () => {
      const results = [
        await get(outsider, taskId),
        await get(owner, UNKNOWN),
        await get(owner, taskId, ws, sibling), // right workspace, wrong project
        await get(owner, taskId, UNKNOWN), // unknown workspace
        await get(outsider, taskId, otherWs, project), // own workspace, foreign project
        await get(outsider, taskId, otherWs, foreignProject), // own project, foreign task
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
      expect(results[1]!.body.error.message).toBe('Task not found');
      expect(JSON.stringify(results.map((r) => r.body))).not.toContain('Full text');
    });

    it.each([
      ['a malformed task id', () => get(owner, 'nope')],
      ['a malformed project id', () => get(owner, taskId, ws, 'nope')],
      ['a query parameter', () => get(owner, taskId).query({ expand: '1' })],
    ])('rejects %s with 400', async (_l, call) => {
      expect((await call()).status).toBe(400);
    });
  });

  describe('PATCH (edit)', () => {
    let taskId: string;
    let otherTask: string;
    beforeEach(async () => {
      taskId = (await create(owner, { title: 'Original', description: 'Text' })).body.data.task.id;
      otherTask = (await create(owner, { title: 'Untouched' })).body.data.task.id;
    });

    it.each([
      ['the owner', () => owner],
      ['a regular member', () => member],
    ])(
      'lets %s edit every field; updatedAt moves forward; other tasks untouched',
      async (_l, who) => {
        const before = { ...row(taskId)! };
        const untouched = { ...row(otherTask)! };

        const res = await patch(who(), taskId, {
          title: '  New title ',
          description: '',
          status: 'IN_PROGRESS',
          priority: 'URGENT',
          ...seen(taskId),
        });

        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data.task).sort()).toEqual(TASK_FIELDS);
        expect(res.body.data.task).toMatchObject({
          id: taskId,
          title: 'New title',
          description: null,
          status: 'IN_PROGRESS',
          priority: 'URGENT',
          projectId: project,
          createdById: owner.id,
          createdAt: before.createdAt.toISOString(),
        });
        expect(row(taskId)!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
        expect(row(otherTask)).toEqual(untouched);
      },
    );

    it.each([
      ['status only', { status: 'DONE' }, { status: 'DONE', title: 'Original' }],
      ['priority only', { priority: 'LOW' }, { priority: 'LOW', title: 'Original' }],
      ['title only', { title: 'Renamed' }, { title: 'Renamed', description: 'Text' }],
      ['description only', { description: 'New' }, { description: 'New', status: 'TODO' }],
    ])('updates %s', async (_l, change, expected) => {
      const res = await patch(member, taskId, { ...change, ...seen(taskId) });
      expect(res.status).toBe(200);
      expect(row(taskId)).toMatchObject(expected);
    });

    it.each([
      ['an empty title', { title: '' }],
      ['a whitespace-only title', { title: '  ' }],
      ['a title over 200 characters', { title: 't'.repeat(201) }],
      ['a description over 5000 characters', { description: 'd'.repeat(5001) }],
      ['an invalid status', { status: 'BLOCKED' }],
      ['a lower-case status', { status: 'done' }],
      ['an invalid priority', { priority: 'NONE' }],
      ['no editable field', {}],
      ['an unknown field', { title: 'X', assignee: UNKNOWN }],
      ['an id', { title: 'X', id: UNKNOWN }],
      ['a projectId', { title: 'X', projectId: UNKNOWN }],
      ['a createdById', { title: 'X', createdById: UNKNOWN }],
      ['a createdAt', { title: 'X', createdAt: '2020-01-01T00:00:00.000Z' }],
      ['an updatedAt', { title: 'X', updatedAt: '2020-01-01T00:00:00.000Z' }],
    ])('rejects %s with 400 and changes nothing', async (_l, body) => {
      const before = { ...row(taskId)! };
      const res = await patch(owner, taskId, { ...body, ...seen(taskId) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(row(taskId)).toEqual(before);
    });

    it.each([
      ['missing', {}],
      ['not a timestamp', { expectedUpdatedAt: 'later' }],
    ])('rejects a %s expectedUpdatedAt with 400', async (_l, precondition) => {
      expect((await patch(owner, taskId, { status: 'DONE', ...precondition })).status).toBe(400);
    });

    it('rejects a stale edit with 409 instead of overwriting the newer change', async () => {
      const version = seen(taskId); // two members loaded the same version
      expect((await patch(owner, taskId, { status: 'DONE', ...version })).status).toBe(200);

      const second = await patch(member, taskId, { priority: 'HIGH', ...version });

      expect(second.status).toBe(409);
      expect(second.body.error.message).toBe(
        'This task was changed by someone else. Reload it to see the latest version.',
      );
      expect(row(taskId)).toMatchObject({ status: 'DONE', priority: 'MEDIUM' });
    });

    it('keeps tasks of archived projects read-only (409)', async () => {
      await archive();
      const before = { ...row(taskId)! };
      const res = await patch(member, taskId, { status: 'DONE', ...seen(taskId) });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('archived');
      expect(row(taskId)).toEqual(before);
    });

    it('answers outsiders, unknown tasks and cross-project/workspace edits with 404', async () => {
      const body = { title: 'Hijack', ...seen(taskId) };
      const results = [
        await patch(outsider, taskId, body),
        await patch(owner, UNKNOWN, body),
        await patch(owner, taskId, body, ws, sibling),
        await patch(owner, taskId, body, UNKNOWN),
        await patch(outsider, taskId, body, otherWs, foreignProject),
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
      expect(row(taskId)!.title).toBe('Original');
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await authed(request(ctx.app).patch(`${tasksPath()}/${taskId}`), owner)
        .type('form')
        .send('title=X');
      expect(res.status).toBe(415);
    });
  });

  describe('project deletion with tasks', () => {
    it('refuses to delete a project that still has tasks (409); nothing is lost', async () => {
      const taskId = (await create(member, { title: 'Keep me' })).body.data.task.id;
      const res = await authed(
        request(ctx.app).delete(`/api/v1/workspaces/${ws}/projects/${project}`),
        owner,
      );
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(
        'This project still has tasks, so it cannot be deleted. Archive it instead to make it read-only.',
      );
      expect(ctx.projects.rows.some((p) => p.id === project)).toBe(true);
      expect(row(taskId)).toBeDefined();
    });

    it('still deletes a project without tasks', async () => {
      const res = await authed(
        request(ctx.app).delete(`/api/v1/workspaces/${ws}/projects/${sibling}`),
        owner,
      );
      expect(res.status).toBe(200);
    });
  });

  describe('security', () => {
    let taskId: string;
    beforeEach(async () => {
      taskId = (await create(owner, { title: 'Secure' })).body.data.task.id;
    });

    it('requires a session for every endpoint', async () => {
      const responses = [
        await request(ctx.app).get(tasksPath()),
        await request(ctx.app).get(`${tasksPath()}/${taskId}`),
        await request(ctx.app).post(tasksPath()).send({ title: 'T' }),
        await request(ctx.app).patch(`${tasksPath()}/${taskId}`).send({ status: 'DONE' }),
      ];
      expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    });

    it('rejects expired and revoked sessions', async () => {
      ctx.sessions.rows.find((s) => s.userId === member.id)!.expiresAt = new Date(Date.now() - 1);
      expect((await list(member)).status).toBe(401);
      expect((await create(member, { title: 'T' })).status).toBe(401);

      await authed(request(ctx.app).post('/api/v1/auth/logout'), owner);
      expect((await get(owner, taskId)).status).toBe(401);
      expect((await patch(owner, taskId, { status: 'DONE', ...seen(taskId) })).status).toBe(401);
      expect(row(taskId)!.status).toBe('TODO');
    });

    it('requires a valid CSRF token and an allowed Origin for mutations', async () => {
      const calls = [
        () => request(ctx.app).post(tasksPath()).send({ title: 'T' }),
        () =>
          request(ctx.app)
            .patch(`${tasksPath()}/${taskId}`)
            .send({ status: 'DONE', ...seen(taskId) }),
      ];
      for (const call of calls) {
        expect((await call().set('Cookie', owner.cookie)).status).toBe(403);
        expect(
          (await call().set('Cookie', owner.cookie).set('X-CSRF-Token', member.csrfToken)).status,
        ).toBe(403);
        expect(
          (
            await call()
              .set('Cookie', owner.cookie)
              .set('X-CSRF-Token', owner.csrfToken)
              .set('Origin', 'https://evil.example')
          ).status,
        ).toBe(403);
      }
      expect(ctx.tasks.rows).toHaveLength(1);
      expect(row(taskId)!.status).toBe('TODO');
    });

    it('needs no CSRF token for reads and grants no CORS access to foreign origins', async () => {
      const res = await list(member).set('Origin', 'https://evil.example');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects malformed UUIDs everywhere', async () => {
      const results = [
        await list(owner, {}, 'nope'),
        await create(owner, { title: 'T' }, ws, 'nope'),
        await get(owner, 'nope'),
        await patch(owner, 'nope', { status: 'DONE', ...seen(taskId) }),
      ];
      expect(results.map((r) => r.status)).toEqual([400, 400, 400, 400]);
    });

    it('returns a generic 503 for every endpoint when the database is unavailable', async () => {
      const failing = await setup(true);
      const account = await failing.signUp('carol@example.com');
      const base = tasksPath(UNKNOWN, UNKNOWN);
      const send = <T extends request.Test>(req: T) =>
        req.set('Cookie', account.cookie).set('X-CSRF-Token', account.csrfToken);
      const responses = [
        await send(request(failing.app).get(base)),
        await send(request(failing.app).get(`${base}/${UNKNOWN}`)),
        await send(request(failing.app).post(base)).send({ title: 'T' }),
        await send(request(failing.app).patch(`${base}/${UNKNOWN}`)).send({
          status: 'DONE',
          expectedUpdatedAt: new Date().toISOString(),
        }),
      ];
      for (const res of responses) {
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
      }
    });

    it('never logs session tokens, CSRF tokens, passwords or task content', async () => {
      const logs = { text: '' };
      const logged = await setup(false, logs);
      const boss = await logged.signUp('boss@example.com');
      const send = <T extends request.Test>(req: T) =>
        req.set('Cookie', boss.cookie).set('X-CSRF-Token', boss.csrfToken);
      const workspaceId = (
        await send(request(logged.app).post('/api/v1/workspaces')).send({ name: 'Team' })
      ).body.data.workspace.id;
      const projectId = (
        await send(request(logged.app).post(`/api/v1/workspaces/${workspaceId}/projects`)).send({
          name: 'P',
        })
      ).body.data.project.id;
      const base = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
      const created = (
        await send(request(logged.app).post(base)).send({
          title: 'Secret task title',
          description: 'Confidential steps',
        })
      ).body.data.task;
      await send(request(logged.app).get(base));
      await send(request(logged.app).get(`${base}/${created.id}`));
      await send(request(logged.app).patch(`${base}/${created.id}`)).send({
        description: 'More confidential steps',
        expectedUpdatedAt: created.updatedAt,
      });

      expect(logs.text).toContain('/tasks');
      for (const secret of [
        boss.cookie.split('=')[1]!,
        boss.csrfToken,
        PASSWORD,
        'Secret task title',
        'Confidential steps',
        'More confidential steps',
      ]) {
        expect(logs.text).not.toContain(secret);
      }
    });
  });
});
