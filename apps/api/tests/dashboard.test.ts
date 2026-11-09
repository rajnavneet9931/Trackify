import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectStatus } from '../src/modules/projects/index.js';
import { completionPercent, dashboardBounds } from '../src/modules/dashboard/dashboard.service.js';
import {
  buildTestApp,
  InMemoryActivityRepository,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableDashboardRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
// Noon UTC, so "today" windows don't depend on when the suite runs.
const NOW = new Date('2026-11-04T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: workspaces,
    projectRepository: projects,
    taskRepository: tasks,
    activityRepository: activities,
    ...(failing && { dashboardRepository: unreachableDashboardRepository }),
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
  return { app, workspaces, projects, tasks, activities, signUp };
}

describe('dashboard windows and completion', () => {
  it('uses the UTC calendar day for "today" and now + 7 days for the week', () => {
    const late = new Date('2026-11-04T23:30:00.000Z');
    const b = dashboardBounds(late);
    expect(b.todayStart.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(b.todayEnd.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(b.weekEnd.toISOString()).toBe('2026-11-11T23:30:00.000Z');
  });

  it('rounds completion down, so only a finished project shows 100%, and is 0 without tasks', () => {
    expect(completionPercent(0, 0)).toBe(0);
    expect(completionPercent(1, 6)).toBe(16);
    expect(completionPercent(199, 200)).toBe(99);
    expect(completionPercent(3, 3)).toBe(100);
  });
});

describe('GET /api/v1/workspaces/:workspaceId/dashboard', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;
  let otherWs: string;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const dashboard = (who: Account, workspaceId = ws) =>
    request(ctx.app).get(`/api/v1/workspaces/${workspaceId}/dashboard`).set('Cookie', who.cookie);
  const newProject = async (by: Account, workspaceId: string, name: string) =>
    (
      await authed(request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects`), by).send({
        name,
      })
    ).body.data.project.id as string;
  /** Creates a task through the API, then sets fields directly on the fake row. */
  const newTask = async (
    by: Account,
    projectId: string,
    title: string,
    fields: Partial<{
      status: 'TODO' | 'IN_PROGRESS' | 'DONE';
      priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
      dueDate: Date | null;
      assigneeId: string | null;
    }> = {},
    workspaceId = ws,
  ) => {
    const res = await authed(
      request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`),
      by,
    ).send({ title });
    const id = res.body.data.task.id as string;
    Object.assign(
      ctx.tasks.rows.find((t) => t.id === id)!,
      fields,
    );
    return id;
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    const newWorkspace = async (by: Account) =>
      (await authed(request(ctx.app).post('/api/v1/workspaces'), by).send({ name: 'Team' })).body
        .data.workspace.id as string;
    ws = await newWorkspace(owner);
    otherWs = await newWorkspace(outsider);
    ctx.workspaces.addMember(ws, member.id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires a session', async () => {
    const res = await request(ctx.app).get(`/api/v1/workspaces/${ws}/dashboard`);
    expect(res.status).toBe(401);
  });

  it('answers outsiders exactly like an unknown workspace (404)', async () => {
    const foreign = await dashboard(outsider);
    const unknown = await dashboard(outsider, UNKNOWN);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body.error.message).toBe(unknown.body.error.message);
    expect(foreign.body.error.code).toBe(unknown.body.error.code);
  });

  it('rejects a malformed workspace id and any query parameter (400)', async () => {
    expect((await dashboard(owner, 'not-a-uuid')).status).toBe(400);
    const res = await request(ctx.app)
      .get(`/api/v1/workspaces/${ws}/dashboard?days=30`)
      .set('Cookie', owner.cookie);
    expect(res.status).toBe(400);
  });

  it.each([
    ['an owner', () => owner],
    ['a regular member', () => member],
  ])('serves %s an empty workspace with zeros, uncached', async (_l, who) => {
    const res = await dashboard(who());

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const d = res.body.data.dashboard;
    expect(Object.keys(d).sort()).toEqual([
      'generatedAt',
      'myWork',
      'projects',
      'recentActivity',
      'tasks',
      'windows',
    ]);
    expect(d).toEqual({
      generatedAt: NOW.toISOString(),
      windows: {
        todayStart: '2026-11-04T00:00:00.000Z',
        todayEnd: '2026-11-05T00:00:00.000Z',
        weekEnd: '2026-11-11T12:00:00.000Z',
      },
      tasks: {
        total: 0,
        byStatus: { TODO: 0, IN_PROGRESS: 0, DONE: 0 },
        byPriority: { LOW: 0, MEDIUM: 0, HIGH: 0, URGENT: 0 },
        overdue: 0,
        dueToday: 0,
        dueNext7Days: 0,
      },
      projects: { active: 0, archived: 0, completion: [] },
      myWork: { assigned: 0, pending: 0, overdue: 0, upcoming: 0, tasks: [] },
      recentActivity: [],
    });
  });

  describe('with tasks', () => {
    let website: string;
    let empty: string;
    let a: string;
    let b: string;

    beforeEach(async () => {
      website = await newProject(owner, ws, 'Website');
      a = await newTask(owner, website, 'A overdue', {
        priority: 'HIGH',
        dueDate: new Date(NOW.getTime() - 2 * HOUR),
        assigneeId: member.id,
      });
      b = await newTask(owner, website, 'B later today', {
        status: 'IN_PROGRESS',
        priority: 'URGENT',
        dueDate: new Date(NOW.getTime() + 3 * HOUR),
        assigneeId: member.id,
      });
      // Completed tasks are never overdue, even when their date has passed.
      await newTask(owner, website, 'C done', {
        status: 'DONE',
        priority: 'LOW',
        dueDate: new Date(NOW.getTime() - DAY),
        assigneeId: member.id,
      });
      // Undated tasks are never overdue or upcoming.
      await newTask(owner, website, 'D undated');
      await newTask(owner, website, 'E in three days', {
        dueDate: new Date(NOW.getTime() + 3 * DAY),
        assigneeId: owner.id,
      });
      await newTask(owner, website, 'F in eight days', {
        dueDate: new Date(NOW.getTime() + 8 * DAY),
      });
      empty = await newProject(owner, ws, 'Empty');
      // Archived projects count as archived, but their tasks are left out of the numbers.
      const old = await newProject(owner, ws, 'Old');
      await newTask(owner, old, 'G archived overdue', {
        dueDate: new Date(NOW.getTime() - DAY),
        assigneeId: member.id,
      });
      ctx.projects.rows.find((p) => p.id === old)!.status = ProjectStatus.ARCHIVED;
      // Another workspace never leaks in.
      const theirs = await newProject(outsider, otherWs, 'Theirs');
      await newTask(
        outsider,
        theirs,
        'Their overdue',
        { dueDate: new Date(NOW.getTime() - DAY) },
        otherWs,
      );
    });

    it('counts tasks by status, priority and deadline over active projects', async () => {
      const { tasks, projects } = (await dashboard(member)).body.data.dashboard;
      expect(tasks).toEqual({
        total: 6,
        byStatus: { TODO: 4, IN_PROGRESS: 1, DONE: 1 },
        byPriority: { LOW: 1, MEDIUM: 3, HIGH: 1, URGENT: 1 },
        overdue: 1,
        dueToday: 2,
        dueNext7Days: 2,
      });
      expect(projects).toEqual({
        active: 2,
        archived: 1,
        completion: [
          { id: empty, name: 'Empty', totalTasks: 0, doneTasks: 0, completionPercent: 0 },
          { id: website, name: 'Website', totalTasks: 6, doneTasks: 1, completionPercent: 16 },
        ],
      });
    });

    it('shows each user only their own work', async () => {
      const mine = (await dashboard(member)).body.data.dashboard.myWork;
      expect(mine).toMatchObject({ assigned: 3, pending: 2, overdue: 1, upcoming: 1 });
      expect(mine.tasks).toEqual([
        {
          id: a,
          title: 'A overdue',
          status: 'TODO',
          priority: 'HIGH',
          dueDate: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
          project: { id: website, name: 'Website' },
        },
        expect.objectContaining({ id: b, status: 'IN_PROGRESS' }),
      ]);

      const owners = (await dashboard(owner)).body.data.dashboard.myWork;
      expect(owners).toMatchObject({ assigned: 1, pending: 1, overdue: 0, upcoming: 1 });
      expect(owners.tasks.map((t: { title: string }) => t.title)).toEqual(['E in three days']);
    });

    it('lists the 10 newest activities of this workspace with links, actor and type only', async () => {
      // 7 tasks were created here (archived project included); 4 more make 11.
      for (const n of [1, 2, 3, 4]) await newTask(member, website, `Extra ${n}`);

      const { recentActivity } = (await dashboard(owner)).body.data.dashboard;
      expect(recentActivity).toHaveLength(10);
      expect(recentActivity[0]).toEqual({
        id: expect.any(String),
        type: 'TASK_CREATED',
        createdAt: expect.any(String),
        actorId: member.id,
        actor: { id: member.id, email: 'member@example.com' },
        task: { id: expect.any(String), title: 'Extra 4' },
        project: { id: website, name: 'Website' },
      });
      const times = recentActivity.map((x: { createdAt: string }) => x.createdAt);
      expect([...times].sort().reverse()).toEqual(times);
      const titles = recentActivity.map((x: { task: { title: string } }) => x.task.title);
      expect(titles).toContain('G archived overdue');
      expect(titles).not.toContain('Their overdue');
      expect(titles).not.toContain('A overdue'); // the oldest one dropped out
    });

    it('hides the email of an actor who left the workspace', async () => {
      await newTask(member, website, 'By member');
      const removed = await authed(
        request(ctx.app).delete(`/api/v1/workspaces/${ws}/members/${member.id}`),
        owner,
      );
      expect(removed.status).toBe(200);

      const entries = (await dashboard(owner)).body.data.dashboard.recentActivity;
      // Removal unassigned their tasks (ASSIGNEE_CHANGED, by the owner, newest).
      expect(entries[0]).toMatchObject({
        type: 'ASSIGNEE_CHANGED',
        actor: { id: owner.id, email: 'owner@example.com' },
      });
      const theirs = entries.find((x: { task: { title: string } }) => x.task.title === 'By member');
      expect(theirs).toMatchObject({ actorId: member.id, actor: null });
      // And the former member can no longer open the dashboard.
      expect((await dashboard(member)).status).toBe(404);
    });
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    ctx = await setup(true);
    owner = await ctx.signUp('owner@example.com');
    const created = await authed(request(ctx.app).post('/api/v1/workspaces'), owner).send({
      name: 'Team',
    });
    const res = await dashboard(owner, created.body.data.workspace.id);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|connection|sql/i);
  });
});
