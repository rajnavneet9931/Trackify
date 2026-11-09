import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { encodeActivityCursor } from '../src/modules/activities/activity-cursor.js';
import {
  buildTestApp,
  InMemoryActivityRepository,
  InMemoryCommentRepository,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableActivityRepository,
  unreachableWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
const ACTIVITY_FIELDS = ['actor', 'actorId', 'createdAt', 'details', 'id', 'taskId', 'type'];

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

async function setup(failing = false) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const workspaces = new InMemoryWorkspaceRepository(users);
  const projects = new InMemoryProjectRepository(workspaces, users);
  const activities = new InMemoryActivityRepository(workspaces, users);
  const tasks = new InMemoryTaskRepository(projects, workspaces, users, activities);
  const comments = new InMemoryCommentRepository(tasks, workspaces, users, activities);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
    projectRepository: projects,
    taskRepository: tasks,
    commentRepository: comments,
    activityRepository: failing ? unreachableActivityRepository : activities,
  });
  const signUp = async (email: string): Promise<Account> => {
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
  return { app, sessions, workspaces, projects, tasks, comments, activities, signUp };
}

describe('task activity history', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let colleague: Account;
  let outsider: Account;
  let ws: string;
  let project: string;
  let otherWs: string;
  let foreignProject: string;
  let foreignTask: string;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const tasksPath = (workspaceId = ws, projectId = project) =>
    `/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const activitiesPath = (taskId: string, workspaceId = ws, projectId = project) =>
    `${tasksPath(workspaceId, projectId)}/${taskId}/activities`;
  const createTask = async (
    who: Account,
    body: object = { title: 'Login API' },
    workspaceId = ws,
    projectId = project,
  ) =>
    (await authed(request(ctx.app).post(tasksPath(workspaceId, projectId)), who).send(body)).body
      .data.task as { id: string; updatedAt: string };
  const version = (taskId: string) => ({
    expectedUpdatedAt: ctx.tasks.rows.find((t) => t.id === taskId)!.updatedAt.toISOString(),
  });
  const editTask = (who: Account, taskId: string, body: object) =>
    authed(request(ctx.app).patch(`${tasksPath()}/${taskId}`), who).send({
      ...version(taskId),
      ...body,
    });
  const assign = (who: Account, taskId: string, assigneeId: string | null) =>
    authed(request(ctx.app).patch(`${tasksPath()}/${taskId}/assignee`), who).send({ assigneeId });
  const commentsPath = (taskId: string) => `${tasksPath()}/${taskId}/comments`;
  const list = (
    who: Account,
    taskId: string,
    query: Record<string, string> = {},
    workspaceId = ws,
    projectId = project,
  ) =>
    request(ctx.app)
      .get(activitiesPath(taskId, workspaceId, projectId))
      .query(query)
      .set('Cookie', who.cookie);
  const timeline = async (taskId: string) => {
    const res = await list(member, taskId, { limit: '50' });
    expect(res.status).toBe(200);
    return res.body.data.activities as {
      type: string;
      actorId: string | null;
      actor: { id: string; email: string } | null;
      details: Record<string, unknown>;
    }[];
  };
  const types = async (taskId: string) => (await timeline(taskId)).map((a) => a.type);

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    colleague = await ctx.signUp('colleague@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    const newWorkspace = async (by: Account) =>
      (await authed(request(ctx.app).post('/api/v1/workspaces'), by).send({ name: 'Team' })).body
        .data.workspace.id as string;
    const newProject = async (by: Account, workspaceId: string) =>
      (
        await authed(request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects`), by).send({
          name: 'Project',
        })
      ).body.data.project.id as string;
    ws = await newWorkspace(owner);
    otherWs = await newWorkspace(outsider);
    ctx.workspaces.addMember(ws, member.id);
    ctx.workspaces.addMember(ws, colleague.id);
    project = await newProject(owner, ws);
    foreignProject = await newProject(outsider, otherWs);
    foreignTask = (await createTask(outsider, { title: 'Theirs' }, otherWs, foreignProject)).id;
  });

  describe('generation', () => {
    it('records task creation by the session user, with the priority', async () => {
      const task = await createTask(member, { title: 'Login API', priority: 'HIGH' });
      const [created, ...rest] = await timeline(task.id);
      expect(rest).toEqual([]);
      expect(created).toMatchObject({
        type: 'TASK_CREATED',
        actorId: member.id,
        actor: { id: member.id, email: member.email },
        details: { type: 'TASK_CREATED', priority: 'HIGH' },
      });
    });

    it('records title (with values) and description (flag only) updates as one entry', async () => {
      const task = await createTask(member);
      await editTask(owner, task.id, { title: 'Login API v2', description: 'Secret plan details' });

      const entries = await timeline(task.id);
      expect(entries.map((a) => a.type)).toEqual(['TASK_CREATED', 'TASK_UPDATED']);
      expect(entries[1]).toMatchObject({
        actorId: owner.id,
        details: {
          type: 'TASK_UPDATED',
          changedFields: ['title', 'description'],
          title: { from: 'Login API', to: 'Login API v2' },
        },
      });
      expect(JSON.stringify(entries)).not.toContain('Secret plan details');

      await editTask(owner, task.id, { description: 'Other text' });
      expect((await timeline(task.id))[2]!.details).toEqual({
        type: 'TASK_UPDATED',
        changedFields: ['description'],
      });
    });

    it('records status and priority changes with previous and new values', async () => {
      const task = await createTask(member);
      await editTask(member, task.id, { status: 'IN_PROGRESS', priority: 'URGENT' });
      await editTask(colleague, task.id, { status: 'DONE' });

      const entries = await timeline(task.id);
      expect(entries.map((a) => [a.type, a.actorId, a.details.from, a.details.to])).toEqual([
        ['TASK_CREATED', member.id, undefined, undefined],
        ['STATUS_CHANGED', member.id, 'TODO', 'IN_PROGRESS'],
        ['PRIORITY_CHANGED', member.id, 'MEDIUM', 'URGENT'],
        ['STATUS_CHANGED', colleague.id, 'IN_PROGRESS', 'DONE'],
      ]);
    });

    it('records nothing for values that did not actually change', async () => {
      const task = await createTask(member, { title: 'Same', priority: 'LOW' });
      const res = await editTask(member, task.id, {
        title: '  Same  ',
        status: 'TODO',
        priority: 'LOW',
        description: null,
      });
      expect(res.status).toBe(200);
      expect(await types(task.id)).toEqual(['TASK_CREATED']);
    });

    it('records assignment, reassignment and unassignment with both assignees', async () => {
      const task = await createTask(member);
      await assign(owner, task.id, member.id);
      await assign(member, task.id, colleague.id);
      await assign(colleague, task.id, null);
      await assign(colleague, task.id, null); // unchanged: no entry

      const entries = (await timeline(task.id)).slice(1);
      expect(entries.map((a) => [a.actorId, a.details.from, a.details.to])).toEqual([
        [owner.id, null, { id: member.id, email: member.email }],
        [
          member.id,
          { id: member.id, email: member.email },
          { id: colleague.id, email: colleague.email },
        ],
        [colleague.id, { id: colleague.id, email: colleague.email }, null],
      ]);
    });

    it('records comment added, edited and deleted with the comment ID only', async () => {
      const task = await createTask(member);
      const comment = (
        await authed(request(ctx.app).post(commentsPath(task.id)), colleague).send({
          content: 'Confidential remark',
        })
      ).body.data.comment;
      await authed(
        request(ctx.app).patch(`${commentsPath(task.id)}/${comment.id}`),
        colleague,
      ).send({
        content: 'Confidential remark, revised',
        expectedUpdatedAt: comment.updatedAt,
      });
      await authed(request(ctx.app).delete(`${commentsPath(task.id)}/${comment.id}`), owner);

      const entries = (await timeline(task.id)).slice(1);
      expect(entries.map((a) => [a.type, a.actorId, a.details.commentId])).toEqual([
        ['COMMENT_ADDED', colleague.id, comment.id],
        ['COMMENT_EDITED', colleague.id, comment.id],
        ['COMMENT_DELETED', owner.id, comment.id],
      ]);
      expect(JSON.stringify(entries)).not.toContain('Confidential');
    });

    it('records no COMMENT_EDITED when the content is unchanged', async () => {
      const task = await createTask(member);
      const comment = (
        await authed(request(ctx.app).post(commentsPath(task.id)), member).send({ content: 'Same' })
      ).body.data.comment;
      const res = await authed(
        request(ctx.app).patch(`${commentsPath(task.id)}/${comment.id}`),
        member,
      ).send({ content: '  Same ', expectedUpdatedAt: comment.updatedAt });
      expect(res.status).toBe(200);
      expect(await types(task.id)).toEqual(['TASK_CREATED', 'COMMENT_ADDED']);
    });

    it('records the unassignment caused by removing the assignee, attributed to the remover', async () => {
      const task = await createTask(member);
      await assign(member, task.id, colleague.id);
      await authed(
        request(ctx.app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`),
        owner,
      );

      const last = (await timeline(task.id)).at(-1)!;
      expect(last).toMatchObject({
        type: 'ASSIGNEE_CHANGED',
        actorId: owner.id,
        details: { from: { id: colleague.id, email: null }, to: null, reason: 'MEMBER_REMOVED' },
      });
    });

    it('records nothing for failed or rejected operations', async () => {
      const task = await createTask(member);
      const before = ctx.activities.rows.length;

      const failures = [
        await authed(request(ctx.app).post(tasksPath()), member).send({ title: '' }), // 400
        await authed(request(ctx.app).post(tasksPath()), outsider).send({ title: 'x' }), // 404
        await authed(request(ctx.app).patch(`${tasksPath()}/${task.id}`), member).send({
          status: 'DONE',
          expectedUpdatedAt: '2020-01-01T00:00:00.000Z', // stale → 409
        }),
        await assign(member, task.id, outsider.id), // 422
        await authed(request(ctx.app).post(commentsPath(task.id)), member).send({ content: '' }), // 400
      ];
      expect(failures.map((r) => r.status)).toEqual([400, 404, 409, 422, 400]);
      expect(ctx.activities.rows.length).toBe(before);
    });

    it('rolls activity back with an operation that fails after recording', async () => {
      const task = await createTask(member);
      const before = ctx.activities.rows.length;
      await expect(
        ctx.tasks.withProjectLock(ws, project, member.id, async (scope) => {
          await scope.record(task.id, {
            type: 'STATUS_CHANGED',
            metadata: { from: 'TODO', to: 'DONE' },
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(ctx.activities.rows.length).toBe(before);
    });

    it('refuses invalid metadata (the operation fails instead of storing it)', async () => {
      const task = await createTask(member);
      await expect(
        ctx.tasks.withProjectLock(ws, project, member.id, (scope) =>
          scope.record(task.id, {
            type: 'COMMENT_ADDED',
            metadata: { commentId: 'not-a-uuid', content: 'leak' } as never,
          }),
        ),
      ).rejects.toThrow();
      expect(await types(task.id)).toEqual(['TASK_CREATED']);
    });
  });

  describe('GET …/activities', () => {
    it.each([
      ['the owner', () => owner],
      ['a regular member', () => member],
    ])('lets %s read the history, oldest first, safe fields only', async (_l, who) => {
      const task = await createTask(member);
      await editTask(member, task.id, { status: 'DONE' });

      const res = await list(who(), task.id);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.meta).toEqual({ limit: 20, nextCursor: null });
      expect(res.body.data.activities.map((a: { type: string }) => a.type)).toEqual([
        'TASK_CREATED',
        'STATUS_CHANGED',
      ]);
      for (const a of res.body.data.activities) {
        expect(Object.keys(a).sort()).toEqual(ACTIVITY_FIELDS);
        expect(a.taskId).toBe(task.id);
      }
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session|token/i);
    });

    it('stays readable in archived projects', async () => {
      const task = await createTask(member);
      await authed(
        request(ctx.app).post(`/api/v1/workspaces/${ws}/projects/${project}/archive`),
        owner,
      );
      const res = await list(member, task.id);
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toHaveLength(1);
    });

    it('answers outsiders and cross-hierarchy requests with 404, leaking nothing', async () => {
      const task = await createTask(member, { title: 'Private title' });
      const results = [
        await list(outsider, task.id),
        await list(owner, foreignTask),
        await list(owner, task.id, {}, ws, foreignProject),
        await list(owner, task.id, {}, UNKNOWN),
        await list(owner, UNKNOWN),
        await list(outsider, task.id, {}, otherWs, foreignProject),
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
      expect(JSON.stringify(results.map((r) => r.body))).not.toMatch(/Private title|TASK_CREATED/);
    });

    it('paginates chronologically (default 20, max 50) with task-bound cursors', async () => {
      const task = await createTask(member);
      const sibling = await createTask(member);
      for (let i = 0; i < 12; i++) {
        await editTask(member, task.id, { priority: i % 2 ? 'LOW' : 'HIGH' });
        await editTask(member, task.id, { status: i % 2 ? 'TODO' : 'DONE' });
      }
      await editTask(member, sibling.id, { status: 'DONE' });
      const all = ctx.activities.rows.filter((a) => a.taskId === task.id).map((a) => a.id);
      expect(all).toHaveLength(25);

      const first = await list(member, task.id);
      expect(first.body.data.activities).toHaveLength(20);
      const second = await list(member, task.id, { cursor: first.body.meta.nextCursor });
      expect(second.body.meta.nextCursor).toBeNull();
      expect(
        [...first.body.data.activities, ...second.body.data.activities].map(
          (a: { id: string }) => a.id,
        ),
      ).toEqual(all);
      expect((await list(member, task.id, { limit: '50' })).body.data.activities).toHaveLength(25);
      for (const limit of ['0', '51', 'x']) {
        expect((await list(member, task.id, { limit })).status).toBe(400);
      }

      const siblingCursor = (await list(member, sibling.id, { limit: '1' })).body.meta.nextCursor;
      expect((await list(member, task.id, { cursor: siblingCursor })).status).toBe(400);
      for (const cursor of [
        '!!!',
        Buffer.from(`c1:${task.id}|1|${UNKNOWN}`).toString('base64url'),
        Buffer.from(`a1:${task.id}|soon|${UNKNOWN}`).toString('base64url'),
      ]) {
        expect((await list(member, task.id, { cursor })).status).toBe(400);
      }
      const ok = encodeActivityCursor(task.id, { createdAt: new Date(0), id: UNKNOWN });
      expect((await list(member, task.id, { cursor: ok })).body.data.activities).toHaveLength(20);
    });

    it('shows a removed actor and a removed assignee without their email', async () => {
      const task = await createTask(colleague);
      await assign(member, task.id, colleague.id);
      await authed(
        request(ctx.app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`),
        owner,
      );

      const entries = await timeline(task.id);
      expect(entries[0]).toMatchObject({ actorId: colleague.id, actor: null });
      expect(entries[1]!.details.to).toEqual({ id: colleague.id, email: null });
      expect(JSON.stringify(entries)).not.toContain(colleague.email);
    });

    it('has no create, edit or delete routes', async () => {
      const task = await createTask(member);
      const id = ctx.activities.rows.find((a) => a.taskId === task.id)!.id;
      const attempts = [
        await authed(request(ctx.app).post(activitiesPath(task.id)), owner).send({
          type: 'TASK_CREATED',
          metadata: {},
        }),
        await authed(request(ctx.app).patch(`${activitiesPath(task.id)}/${id}`), owner).send({
          metadata: {},
        }),
        await authed(request(ctx.app).delete(`${activitiesPath(task.id)}/${id}`), owner),
        await authed(request(ctx.app).put(activitiesPath(task.id)), owner).send({}),
      ];
      expect(attempts.map((r) => r.status)).toEqual([404, 404, 404, 404]);
      expect(await types(task.id)).toEqual(['TASK_CREATED']);
    });

    it('requires a session, validates IDs and the query', async () => {
      const task = await createTask(member);
      expect((await request(ctx.app).get(activitiesPath(task.id))).status).toBe(401);
      ctx.sessions.rows.find((s) => s.userId === member.id)!.expiresAt = new Date(Date.now() - 1);
      expect((await list(member, task.id)).status).toBe(401);
      expect((await list(owner, 'nope')).status).toBe(400);
      expect((await list(owner, task.id, { foo: '1' })).status).toBe(400);
    });

    it('returns a generic 503 when the database is unavailable', async () => {
      const failing = await setup(true);
      const account = await failing.signUp('carol@example.com');
      const res = await request(failing.app)
        .get(`/api/v1/workspaces/${UNKNOWN}/projects/${UNKNOWN}/tasks/${UNKNOWN}/activities`)
        .set('Cookie', account.cookie);
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
    });
  });
});
