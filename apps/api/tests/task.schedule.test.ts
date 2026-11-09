import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  InMemoryActivityRepository,
  InMemoryCommentRepository,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
const DUE = '2026-12-01T17:00:00.000Z';
const REMIND = '2026-12-01T09:00:00.000Z';

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

async function setup() {
  const users = new InMemoryUserRepository();
  const workspaces = new InMemoryWorkspaceRepository(users);
  const projects = new InMemoryProjectRepository(workspaces, users);
  const activities = new InMemoryActivityRepository(workspaces, users);
  const tasks = new InMemoryTaskRepository(projects, workspaces, users, activities);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: new InMemorySessionRepository(users),
    workspaceRepository: workspaces,
    projectRepository: projects,
    taskRepository: tasks,
    commentRepository: new InMemoryCommentRepository(tasks, workspaces, users, activities),
    activityRepository: activities,
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
  return { app, workspaces, projects, tasks, activities, signUp };
}

describe('task due dates and reminders', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;
  let project: string;
  let otherWs: string;
  let foreignProject: string;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const tasksPath = (workspaceId = ws, projectId = project) =>
    `/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const create = (who: Account, body: object, workspaceId = ws, projectId = project) =>
    authed(request(ctx.app).post(tasksPath(workspaceId, projectId)), who).send({
      title: 'Ship it',
      ...body,
    });
  const row = (id: string) => ctx.tasks.rows.find((t) => t.id === id)!;
  const version = (id: string) => ({ expectedUpdatedAt: row(id).updatedAt.toISOString() });
  const edit = (who: Account, id: string, body: object, workspaceId = ws, projectId = project) =>
    authed(request(ctx.app).patch(`${tasksPath(workspaceId, projectId)}/${id}`), who).send({
      ...version(id),
      ...body,
    });
  const details = (who: Account, id: string) =>
    request(ctx.app).get(`${tasksPath()}/${id}`).set('Cookie', who.cookie);
  const reminders = (id: string) =>
    ctx.tasks.reminders
      .filter((r) => r.taskId === id)
      .map((r) => [r.status, r.remindAt.toISOString()]);

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    const newWorkspace = async (by: Account) =>
      (await authed(request(ctx.app).post('/api/v1/workspaces'), by).send({ name: 'Team' })).body
        .data.workspace.id as string;
    const newProject = async (by: Account, workspaceId: string) =>
      (
        await authed(request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects`), by).send({
          name: 'P',
        })
      ).body.data.project.id as string;
    ws = await newWorkspace(owner);
    otherWs = await newWorkspace(outsider);
    ctx.workspaces.addMember(ws, member.id);
    project = await newProject(owner, ws);
    foreignProject = await newProject(outsider, otherWs);
  });

  describe('create', () => {
    it.each([
      ['the owner', () => owner],
      ['a member', () => member],
    ])(
      'lets %s create a task with a due date and a reminder (stored in UTC, reminder scheduled)',
      async (_l, who) => {
        const res = await create(who(), { dueDate: DUE, reminderAt: REMIND });
        expect(res.status).toBe(201);
        expect(res.body.data.task).toMatchObject({ dueDate: DUE, reminderAt: REMIND });
        expect(reminders(res.body.data.task.id)).toEqual([['PENDING', REMIND]]);
      },
    );

    it('defaults both to null and schedules nothing', async () => {
      const res = await create(member, {});
      expect(res.body.data.task).toMatchObject({ dueDate: null, reminderAt: null });
      expect(reminders(res.body.data.task.id)).toEqual([]);
    });

    it('accepts a due date without a reminder, and a reminder equal to the due date', async () => {
      expect((await create(member, { dueDate: DUE })).body.data.task.reminderAt).toBeNull();
      expect((await create(member, { dueDate: DUE, reminderAt: DUE })).status).toBe(201);
    });

    it('normalizes timezone offsets to UTC', async () => {
      const res = await create(member, {
        dueDate: '2026-12-01T18:30:00+05:30', // = 13:00 UTC
        reminderAt: '2026-12-01T06:00:00-05:00', // = 11:00 UTC
      });
      expect(res.status).toBe(201);
      expect(res.body.data.task).toMatchObject({
        dueDate: '2026-12-01T13:00:00.000Z',
        reminderAt: '2026-12-01T11:00:00.000Z',
      });
      expect(row(res.body.data.task.id).dueDate!.toISOString()).toBe('2026-12-01T13:00:00.000Z');
    });

    it.each([
      ['a reminder without a due date', { reminderAt: REMIND }, 'A reminder requires a due date'],
      [
        'a reminder after the due date',
        { dueDate: REMIND, reminderAt: DUE },
        'The reminder cannot be after the due date',
      ],
      ['a timestamp without a timezone', { dueDate: '2026-12-01T17:00:00' }, 'timezone'],
      ['a date only', { dueDate: '2026-12-01' }, 'timezone'],
      ['an impossible date', { dueDate: '2026-02-30T10:00:00Z' }, 'valid date'],
      ['a year out of range', { dueDate: '1999-12-31T10:00:00Z' }, 'valid date'],
      ['garbage', { dueDate: 'tomorrow' }, 'timezone'],
      ['a number', { dueDate: 1764608400000 }, ''],
    ])('rejects %s with 400 and stores nothing', async (_l, body, message) => {
      const res = await create(member, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body.error.details)).toContain(message);
      expect(ctx.tasks.rows).toHaveLength(0);
      expect(ctx.tasks.reminders).toHaveLength(0);
    });

    it('records the due date in TASK_CREATED', async () => {
      const id = (await create(member, { dueDate: DUE })).body.data.task.id;
      expect(ctx.activities.rows.find((a) => a.taskId === id)!.metadata).toEqual({
        priority: 'MEDIUM',
        dueDate: DUE,
      });
    });
  });

  describe('update', () => {
    let id: string;
    beforeEach(async () => {
      id = (await create(member, { dueDate: DUE, reminderAt: REMIND })).body.data.task.id;
    });

    it('updates the due date and reschedules a changed reminder (old one cancelled)', async () => {
      const res = await edit(owner, id, {
        dueDate: '2026-12-05T17:00:00Z',
        reminderAt: '2026-12-04T09:00:00Z',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.task).toMatchObject({
        dueDate: '2026-12-05T17:00:00.000Z',
        reminderAt: '2026-12-04T09:00:00.000Z',
      });
      expect(reminders(id)).toEqual([
        ['CANCELLED', REMIND],
        ['PENDING', '2026-12-04T09:00:00.000Z'],
      ]);
    });

    it('changing only the due date keeps the scheduled reminder', async () => {
      expect((await edit(member, id, { dueDate: '2026-12-10T17:00:00Z' })).status).toBe(200);
      expect(reminders(id)).toEqual([['PENDING', REMIND]]);
    });

    it('removes the reminder with null (pending one cancelled)', async () => {
      const res = await edit(member, id, { reminderAt: null });
      expect(res.body.data.task).toMatchObject({ dueDate: DUE, reminderAt: null });
      expect(reminders(id)).toEqual([['CANCELLED', REMIND]]);
    });

    it('removes both with null', async () => {
      const res = await edit(member, id, { dueDate: null, reminderAt: null });
      expect(res.status).toBe(200);
      expect(res.body.data.task).toMatchObject({ dueDate: null, reminderAt: null });
    });

    it.each([
      [
        'removing the due date while a reminder stays',
        { dueDate: null },
        'A reminder requires a due date',
      ],
      [
        'moving the due date before the reminder',
        { dueDate: '2026-12-01T08:00:00Z' },
        'The reminder cannot be after the due date',
      ],
      [
        'moving the reminder after the due date',
        { reminderAt: '2026-12-02T00:00:00Z' },
        'The reminder cannot be after the due date',
      ],
      ['an invalid timestamp', { dueDate: 'next week' }, 'timezone'],
    ])(
      'rejects %s (checked on the resulting values) and changes nothing',
      async (_l, body, msg) => {
        const before = { ...row(id) };
        const res = await edit(member, id, body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(JSON.stringify(res.body.error.details)).toContain(msg);
        expect(row(id)).toEqual(before);
        expect(reminders(id)).toEqual([['PENDING', REMIND]]);
      },
    );

    it('accepts dueDate/reminderAt alone as the only change', async () => {
      expect((await edit(member, id, { reminderAt: '2026-11-30T09:00:00Z' })).status).toBe(200);
    });

    it('keeps optimistic concurrency: a stale edit changes and schedules nothing', async () => {
      const stale = version(id);
      await edit(member, id, { status: 'DONE' });
      const res = await authed(request(ctx.app).patch(`${tasksPath()}/${id}`), owner).send({
        ...stale,
        reminderAt: null,
      });
      expect(res.status).toBe(409);
      expect(row(id).reminderAt!.toISOString()).toBe(REMIND);
      expect(reminders(id)).toEqual([['PENDING', REMIND]]);
    });

    it('records due date and reminder changes (no entry when unchanged)', async () => {
      await edit(member, id, { dueDate: DUE, reminderAt: REMIND }); // unchanged
      await edit(member, id, { dueDate: '2026-12-02T17:00:00Z', reminderAt: null });
      const updates = ctx.activities.rows.filter(
        (a) => a.taskId === id && a.type === 'TASK_UPDATED',
      );
      expect(updates.map((a) => a.metadata)).toEqual([
        {
          changedFields: ['dueDate', 'reminderAt'],
          dueDate: { from: DUE, to: '2026-12-02T17:00:00.000Z' },
          reminderAt: { from: REMIND, to: null },
        },
      ]);
    });

    it('archived projects are read-only (409, nothing changed)', async () => {
      await authed(
        request(ctx.app).post(`/api/v1/workspaces/${ws}/projects/${project}/archive`),
        owner,
      );
      const res = await edit(member, id, { dueDate: null, reminderAt: null });
      expect(res.status).toBe(409);
      expect(row(id).dueDate!.toISOString()).toBe(DUE);
      expect(reminders(id)).toEqual([['PENDING', REMIND]]);
    });

    it('outsiders and cross-workspace requests get 404 and change nothing', async () => {
      expect((await edit(outsider, id, { dueDate: null, reminderAt: null })).status).toBe(404);
      expect((await edit(outsider, id, { dueDate: null }, otherWs, foreignProject)).status).toBe(
        404,
      );
      expect((await create(owner, { dueDate: DUE }, ws, foreignProject)).status).toBe(404);
      expect(row(id).dueDate!.toISOString()).toBe(DUE);
    });
  });

  describe('details', () => {
    it('shows the latest reminder state', async () => {
      const id = (await create(member, { dueDate: DUE, reminderAt: REMIND })).body.data.task.id;
      const res = await details(member, id);
      expect(res.body.data.reminder).toEqual({ status: 'PENDING', remindAt: REMIND, sentAt: null });
      expect(res.body.data.task).toMatchObject({ dueDate: DUE, reminderAt: REMIND });

      await edit(member, id, { reminderAt: null });
      expect((await details(member, id)).body.data.reminder).toMatchObject({ status: 'CANCELLED' });
    });

    it('is null when no reminder was ever scheduled', async () => {
      const id = (await create(member, {})).body.data.task.id;
      expect((await details(member, id)).body.data.reminder).toBeNull();
    });

    it('lists tasks with their due dates', async () => {
      await create(member, { dueDate: DUE });
      const res = await request(ctx.app).get(tasksPath()).set('Cookie', owner.cookie);
      expect(res.body.data.tasks[0]).toMatchObject({ dueDate: DUE, reminderAt: null });
    });
  });
});

describe('notifications endpoint (auth only; behaviour is covered against PostgreSQL)', () => {
  it('requires a session and validates input', async () => {
    const ctx = await setup();
    const user = await ctx.signUp('n@example.com');
    expect((await request(ctx.app).get('/api/v1/notifications')).status).toBe(401);
    expect(
      (
        await request(ctx.app)
          .get('/api/v1/notifications')
          .query({ limit: '0' })
          .set('Cookie', user.cookie)
      ).status,
    ).toBe(400);
    const markRead = await request(ctx.app)
      .post(`/api/v1/notifications/not-a-uuid/read`)
      .set('Cookie', user.cookie)
      .set('X-CSRF-Token', user.csrfToken);
    expect(markRead.status).toBe(400);
    const noCsrf = await request(ctx.app)
      .post(`/api/v1/notifications/${UNKNOWN}/read`)
      .set('Cookie', user.cookie);
    expect(noCsrf.status).toBe(403);
  });
});
