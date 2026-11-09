import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

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
  const tasks = new InMemoryTaskRepository(projects, workspaces, users);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
    projectRepository: failing ? unreachableProjectRepository : projects,
    taskRepository: failing ? unreachableTaskRepository : tasks,
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
  return { app, sessions, workspaces, projects, tasks, signUp };
}

describe('PATCH …/tasks/:taskId/assignee', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let colleague: Account; // another member of the same workspace
  let outsider: Account; // owner of another workspace
  let stranger: Account; // registered, member of nothing
  let ws: string;
  let project: string;
  let sibling: string;
  let otherWs: string;
  let foreignProject: string;
  let task: string;
  let foreignTask: string;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const assignPath = (taskId = task, workspaceId = ws, projectId = project) =>
    `/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}/assignee`;
  const assign = (
    who: Account,
    assigneeId: string | null,
    taskId = task,
    workspaceId = ws,
    projectId = project,
  ) =>
    authed(request(ctx.app).patch(assignPath(taskId, workspaceId, projectId)), who).send({
      assigneeId,
    });
  const row = (id = task) => ctx.tasks.rows.find((t) => t.id === id)!;
  const newProject = async (by: Account, workspaceId: string, name: string) =>
    (
      await authed(request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects`), by).send({
        name,
      })
    ).body.data.project.id as string;
  const newTask = async (by: Account, workspaceId: string, projectId: string, title: string) =>
    (
      await authed(
        request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`),
        by,
      ).send({ title })
    ).body.data.task.id as string;

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    colleague = await ctx.signUp('colleague@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    stranger = await ctx.signUp('stranger@example.com');
    const newWorkspace = async (by: Account) =>
      (await authed(request(ctx.app).post('/api/v1/workspaces'), by).send({ name: 'Team' })).body
        .data.workspace.id as string;
    ws = await newWorkspace(owner);
    otherWs = await newWorkspace(outsider);
    ctx.workspaces.addMember(ws, member.id);
    ctx.workspaces.addMember(ws, colleague.id);
    project = await newProject(owner, ws, 'Website');
    sibling = await newProject(owner, ws, 'Mobile');
    foreignProject = await newProject(outsider, otherWs, 'Theirs');
    task = await newTask(owner, ws, project, 'Implement login');
    foreignTask = await newTask(outsider, otherWs, foreignProject, 'Their task');
  });

  it('new tasks start unassigned and expose the assignee fields', async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/workspaces/${ws}/projects/${project}/tasks/${task}`)
      .set('Cookie', member.cookie);
    expect(res.body.data.task).toMatchObject({ assigneeId: null, assignee: null });
  });

  it.each([
    ['the owner', () => owner],
    ['a regular member', () => member],
  ])('lets %s assign an unassigned task to a member', async (_l, who) => {
    const before = row().updatedAt.getTime();
    const res = await assign(who(), colleague.id);

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(true);
    expect(res.body.data.task).toMatchObject({
      id: task,
      assigneeId: colleague.id,
      assignee: { id: colleague.id, email: 'colleague@example.com' },
    });
    expect(Object.keys(res.body.data.task.assignee).sort()).toEqual(['email', 'id']);
    expect(row().assigneeId).toBe(colleague.id);
    expect(row().updatedAt.getTime()).toBeGreaterThan(before);
  });

  it('lets members assign themselves and owners', async () => {
    expect((await assign(member, member.id)).body.data.task.assigneeId).toBe(member.id);
    expect((await assign(member, owner.id)).body.data.task.assigneeId).toBe(owner.id);
  });

  it('reassigns an assigned task to another member', async () => {
    await assign(owner, member.id);
    const res = await assign(member, colleague.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ changed: true, task: { assigneeId: colleague.id } });
    expect(row().assigneeId).toBe(colleague.id);
  });

  it('unassigns with assigneeId: null', async () => {
    await assign(owner, member.id);
    const res = await assign(colleague, null);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      changed: true,
      task: { assigneeId: null, assignee: null },
    });
    expect(row().assigneeId).toBeNull();
  });

  it('is idempotent: the same assignee again changes nothing', async () => {
    await assign(owner, member.id);
    const before = { ...row() };
    const res = await assign(owner, member.id);
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    expect(row()).toEqual(before);

    await assign(owner, null);
    expect((await assign(owner, null)).body.data.changed).toBe(false);
  });

  it('accepts an upper-case assignee UUID (compared in lower case)', async () => {
    const res = await assign(owner, colleague.id.toUpperCase());
    expect(res.status).toBe(200);
    expect(row().assigneeId).toBe(colleague.id);
  });

  it.each([
    ['a registered user who belongs to no workspace', () => stranger.id],
    ['a member of another workspace', () => outsider.id],
    ['an unknown user ID', () => UNKNOWN],
  ])('rejects %s with the same 422 and changes nothing', async (_l, assignee) => {
    await assign(owner, member.id);
    const before = { ...row() };
    const res = await assign(owner, assignee());

    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      message: 'The assignee must be a member of this workspace.',
    });
    expect(row()).toEqual(before);
    expect(JSON.stringify(res.body)).not.toMatch(/outsider@|stranger@/);
  });

  it.each([
    ['a malformed assigneeId', { assigneeId: 'not-a-uuid' }],
    ['a numeric assigneeId', { assigneeId: 42 }],
    ['a missing assigneeId', {}],
    ['an extra field', { assigneeId: null, note: 'x' }],
    ['a body workspaceId', { assigneeId: null, workspaceId: UNKNOWN }],
    ['a body projectId', { assigneeId: null, projectId: UNKNOWN }],
    ['a body taskId', { assigneeId: null, taskId: UNKNOWN }],
  ])('rejects %s with 400', async (_l, body) => {
    const res = await authed(request(ctx.app).patch(assignPath()), owner).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(row().assigneeId).toBeNull();
  });

  it('rejects malformed route IDs, query parameters and non-JSON bodies', async () => {
    expect((await assign(owner, null, 'nope')).status).toBe(400);
    expect((await assign(owner, null, task, ws, 'nope')).status).toBe(400);
    expect((await assign(owner, null).query({ force: '1' })).status).toBe(400);
    const form = await authed(request(ctx.app).patch(assignPath()), owner)
      .type('form')
      .send('assigneeId=x');
    expect(form.status).toBe(415);
  });

  it('cannot assign through task editing (only the assignee endpoint or creation)', async () => {
    const edited = await authed(
      request(ctx.app).patch(`/api/v1/workspaces/${ws}/projects/${project}/tasks/${task}`),
      owner,
    ).send({ assigneeId: member.id, expectedUpdatedAt: row().updatedAt.toISOString() });
    expect(edited.status).toBe(400);
    expect(row().assigneeId).toBeNull();
  });

  it('refuses assignment changes in archived projects (409)', async () => {
    await assign(owner, member.id);
    await authed(
      request(ctx.app).post(`/api/v1/workspaces/${ws}/projects/${project}/archive`),
      owner,
    );
    const before = { ...row() };

    for (const assignee of [colleague.id, null]) {
      const res = await assign(member, assignee);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('archived');
    }
    expect(row()).toEqual(before);
  });

  it('answers outsiders, foreign and unknown tasks/projects/workspaces with 404', async () => {
    const results = [
      await assign(outsider, outsider.id), // outsider on our task
      await assign(owner, member.id, foreignTask, ws, project), // foreign task via our project
      await assign(owner, member.id, task, ws, sibling), // our task via the wrong project
      await assign(owner, member.id, task, otherWs, project), // not a member of that workspace
      await assign(outsider, outsider.id, task, otherWs, foreignProject), // own project, our task
      await assign(owner, member.id, UNKNOWN), // unknown task
      await assign(owner, member.id, task, UNKNOWN), // unknown workspace
    ];
    expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(row().assigneeId).toBeNull();
    expect(row(foreignTask).assigneeId).toBeNull();
    expect(JSON.stringify(results.map((r) => r.body))).not.toMatch(/Their task|Implement login/);
  });

  it('reports an unknown task (404) before an invalid assignee (422)', async () => {
    expect((await assign(owner, stranger.id, UNKNOWN)).status).toBe(404);
  });

  it('requires a session, a valid CSRF token and an allowed Origin', async () => {
    const path = assignPath();
    expect((await request(ctx.app).patch(path).send({ assigneeId: null })).status).toBe(401);
    expect(
      (await request(ctx.app).patch(path).set('Cookie', owner.cookie).send({ assigneeId: null }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app)
          .patch(path)
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Token', member.csrfToken)
          .send({ assigneeId: member.id })
      ).status,
    ).toBe(403);
    expect((await assign(owner, member.id).set('Origin', 'https://evil.example')).status).toBe(403);
    expect(row().assigneeId).toBeNull();
  });

  it('rejects expired and revoked sessions', async () => {
    ctx.sessions.rows.find((s) => s.userId === member.id)!.expiresAt = new Date(Date.now() - 1);
    expect((await assign(member, member.id)).status).toBe(401);
    await authed(request(ctx.app).post('/api/v1/auth/logout'), owner);
    expect((await assign(owner, owner.id)).status).toBe(401);
    expect(row().assigneeId).toBeNull();
  });

  it('shows the assignee in task lists and details', async () => {
    await assign(owner, colleague.id);
    const list = await request(ctx.app)
      .get(`/api/v1/workspaces/${ws}/projects/${project}/tasks`)
      .set('Cookie', member.cookie);
    expect(list.body.data.tasks[0]).toMatchObject({
      assigneeId: colleague.id,
      assignee: { id: colleague.id, email: 'colleague@example.com' },
    });
    const detail = await request(ctx.app)
      .get(`/api/v1/workspaces/${ws}/projects/${project}/tasks/${task}`)
      .set('Cookie', member.cookie);
    expect(detail.body.data.task.assignee).toEqual({
      id: colleague.id,
      email: 'colleague@example.com',
    });
    expect(JSON.stringify(detail.body)).not.toMatch(/password|hash|session|token/i);
  });

  it('removing a member unassigns them in that workspace only (other tasks untouched)', async () => {
    // The colleague is assigned here and also belongs to the other workspace.
    ctx.workspaces.addMember(otherWs, colleague.id);
    await assign(owner, colleague.id);
    const siblingTask = await newTask(owner, ws, sibling, 'Sibling');
    await assign(owner, colleague.id, siblingTask, ws, sibling);
    const memberTask = await newTask(owner, ws, project, 'Member task');
    await assign(owner, member.id, memberTask);
    await assign(outsider, colleague.id, foreignTask, otherWs, foreignProject);
    const before = row().updatedAt.getTime();

    const removed = await authed(
      request(ctx.app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`),
      owner,
    );

    expect(removed.status).toBe(200);
    expect(row().assigneeId).toBeNull();
    expect(row().updatedAt.getTime()).toBeGreaterThan(before);
    expect(row(siblingTask).assigneeId).toBeNull();
    expect(row(memberTask).assigneeId).toBe(member.id);
    expect(row(foreignTask).assigneeId).toBe(colleague.id);
    // And they can no longer be assigned here.
    expect((await assign(owner, colleague.id)).status).toBe(422);
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    const failing = await setup(true);
    const account = await failing.signUp('carol@example.com');
    const res = await authed(
      request(failing.app).patch(
        `/api/v1/workspaces/${UNKNOWN}/projects/${UNKNOWN}/tasks/${UNKNOWN}/assignee`,
      ),
      account,
    ).send({ assigneeId: null });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
  });
});
