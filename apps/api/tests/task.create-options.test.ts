import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  InMemoryActivityRepository,
  InMemoryNotificationRepository,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

/** Creating a task with a status and an assignee in one request (one transaction). */
describe('POST …/tasks with status and assignee', () => {
  let app: ReturnType<typeof buildTestApp>;
  let tasks: InMemoryTaskRepository;
  let activities: InMemoryActivityRepository;
  let notifications: InMemoryNotificationRepository;
  let workspaces: InMemoryWorkspaceRepository;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;
  let project: string;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const create = (who: Account, body: object) =>
    authed(request(app).post(`/api/v1/workspaces/${ws}/projects/${project}/tasks`), who).send(body);

  beforeEach(async () => {
    const users = new InMemoryUserRepository();
    const sessions = new InMemorySessionRepository(users);
    workspaces = new InMemoryWorkspaceRepository(users);
    const projects = new InMemoryProjectRepository(workspaces, users);
    activities = new InMemoryActivityRepository(workspaces, users);
    tasks = new InMemoryTaskRepository(projects, workspaces, users, activities);
    notifications = new InMemoryNotificationRepository(workspaces, users, tasks, projects);
    app = buildTestApp({
      userRepository: users,
      sessionRepository: sessions,
      workspaceRepository: workspaces,
      projectRepository: projects,
      taskRepository: tasks,
      activityRepository: activities,
      notificationRepository: notifications,
    });
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
    ws = (await authed(request(app).post('/api/v1/workspaces'), owner).send({ name: 'Team' })).body
      .data.workspace.id;
    workspaces.addMember(ws, member.id);
    project = (
      await authed(request(app).post(`/api/v1/workspaces/${ws}/projects`), owner).send({
        name: 'Website',
      })
    ).body.data.project.id;
  });

  it('defaults to an unassigned "To do" task', async () => {
    const res = await create(member, { title: 'Plain' });
    expect(res.status).toBe(201);
    expect(res.body.data.task).toMatchObject({
      status: 'TODO',
      assigneeId: null,
      assignee: null,
    });
  });

  it('creates with a status and an assignee, recording history and notifying them', async () => {
    const res = await create(owner, {
      title: 'Launch',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      assigneeId: member.id.toUpperCase(), // compared in lower case
    });
    expect(res.status).toBe(201);
    const task = res.body.data.task;
    expect(task).toMatchObject({
      title: 'Launch',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      assigneeId: member.id,
      assignee: { id: member.id, email: 'member@example.com' },
    });

    const history = activities.rows.filter((a) => a.taskId === task.id).map((a) => a.type);
    expect(history).toEqual(['TASK_CREATED', 'ASSIGNEE_CHANGED']);
    expect(activities.rows.find((a) => a.type === 'TASK_CREATED')!.metadata).toEqual({
      priority: 'HIGH',
      status: 'IN_PROGRESS',
    });
    expect(notifications.rows.map((n) => [n.recipientId, n.type])).toEqual([
      [member.id, 'TASK_ASSIGNED'],
    ]);

    // Readable like any task, with the same fields.
    const detail = await request(app)
      .get(`/api/v1/workspaces/${ws}/projects/${project}/tasks/${task.id}`)
      .set('Cookie', member.cookie);
    expect(detail.body.data.task).toMatchObject({ status: 'IN_PROGRESS', assigneeId: member.id });
  });

  it('does not notify the creator about assigning themselves', async () => {
    const res = await create(member, { title: 'Mine', assigneeId: member.id });
    expect(res.status).toBe(201);
    expect(notifications.rows).toEqual([]);
  });

  it.each([
    ['someone outside the workspace', () => outsider.id],
    ['an unknown user', () => UNKNOWN],
  ])('refuses to assign %s (422) and creates nothing', async (_l, assignee) => {
    const res = await create(owner, { title: 'T', assigneeId: assignee() });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('The assignee must be a member of this workspace.');
    expect(tasks.rows).toEqual([]);
    expect(activities.rows).toEqual([]);
    expect(notifications.rows).toEqual([]);
  });

  it('accepts an explicit null assignee and a DONE status', async () => {
    const res = await create(owner, { title: 'Done already', status: 'DONE', assigneeId: null });
    expect(res.status).toBe(201);
    expect(res.body.data.task).toMatchObject({ status: 'DONE', assigneeId: null });
  });

  it('still refuses outsiders (404) whatever they send', async () => {
    const res = await create(outsider, { title: 'T', assigneeId: outsider.id, status: 'DONE' });
    expect(res.status).toBe(404);
    expect(tasks.rows).toEqual([]);
  });
});
