import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { encodeNotificationCursor } from '../src/modules/notifications/notification.service.js';
import { ProjectStatus } from '../src/modules/projects/index.js';
import {
  buildTestApp,
  InMemoryActivityRepository,
  InMemoryCommentRepository,
  InMemoryNotificationRepository,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableNotificationRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
const RESPONSE_FIELDS = [
  'actor',
  'actorId',
  'createdAt',
  'id',
  'isRead',
  'message',
  'readAt',
  'resourceId',
  'resourceType',
  'target',
  'title',
  'type',
  'workspaceId',
];

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
  const notifications = new InMemoryNotificationRepository(workspaces, users, tasks, projects);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: workspaces,
    projectRepository: projects,
    taskRepository: tasks,
    commentRepository: comments,
    activityRepository: activities,
    notificationRepository: failing ? unreachableNotificationRepository : notifications,
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
  return { app, workspaces, projects, tasks, notifications, signUp };
}

describe('in-app notifications', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let colleague: Account;
  let outsider: Account;
  let ws: string;
  let project: string;
  let task: string;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const taskPath = (id = task) => `/api/v1/workspaces/${ws}/projects/${project}/tasks/${id}`;
  const assign = (who: Account, assigneeId: string | null, id = task) =>
    authed(request(ctx.app).patch(`${taskPath(id)}/assignee`), who).send({ assigneeId });
  const comment = (who: Account, id = task) =>
    authed(request(ctx.app).post(`${taskPath(id)}/comments`), who).send({ content: 'Secret note' });
  const newTask = async (by: Account, title = 'Fix login') =>
    (
      await authed(
        request(ctx.app).post(`/api/v1/workspaces/${ws}/projects/${project}/tasks`),
        by,
      ).send({ title })
    ).body.data.task.id as string;
  const inbox = async (who: Account, query: Record<string, string> = {}) => {
    const res = await request(ctx.app)
      .get('/api/v1/notifications')
      .query(query)
      .set('Cookie', who.cookie);
    expect(res.status).toBe(200);
    return res.body.data.notifications as {
      id: string;
      type: string;
      title: string;
      message: string;
      isRead: boolean;
      readAt: string | null;
      actor: { id: string; email: string } | null;
      target: { workspaceId: string; projectId: string | null; taskId: string | null } | null;
    }[];
  };
  const unread = async (who: Account) =>
    (await request(ctx.app).get('/api/v1/notifications/unread-count').set('Cookie', who.cookie))
      .body.data.unreadCount as number;

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    colleague = await ctx.signUp('colleague@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    ws = (await authed(request(ctx.app).post('/api/v1/workspaces'), owner).send({ name: 'Team' }))
      .body.data.workspace.id;
    ctx.workspaces.addMember(ws, member.id);
    ctx.workspaces.addMember(ws, colleague.id);
    project = (
      await authed(request(ctx.app).post(`/api/v1/workspaces/${ws}/projects`), owner).send({
        name: 'Website',
      })
    ).body.data.project.id;
    task = await newTask(owner);
  });

  it('requires a session on every endpoint', async () => {
    const calls = [
      request(ctx.app).get('/api/v1/notifications'),
      request(ctx.app).get('/api/v1/notifications/unread-count'),
      request(ctx.app).patch(`/api/v1/notifications/${UNKNOWN}/read`),
      request(ctx.app).patch('/api/v1/notifications/read-all'),
      request(ctx.app).delete(`/api/v1/notifications/${UNKNOWN}`),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
  });

  describe('task assignment', () => {
    it('notifies the new assignee with a safe message, actor and navigation target', async () => {
      expect((await assign(owner, member.id)).status).toBe(200);

      const [n, ...rest] = await inbox(member);
      expect(rest).toEqual([]);
      expect(Object.keys(n!).sort()).toEqual(RESPONSE_FIELDS);
      expect(n).toMatchObject({
        type: 'TASK_ASSIGNED',
        title: 'Task assigned to you',
        message: 'You are now the assignee of “Fix login”.',
        workspaceId: ws,
        resourceType: 'TASK',
        resourceId: task,
        actorId: owner.id,
        actor: { id: owner.id, email: 'owner@example.com' },
        isRead: false,
        readAt: null,
        target: { workspaceId: ws, projectId: project, taskId: task },
      });
      expect(await unread(member)).toBe(1);
      expect(await inbox(owner)).toEqual([]); // the actor hears nothing
    });

    it('notifies on reassignment, only the new assignee', async () => {
      await assign(owner, member.id);
      await assign(owner, colleague.id);

      const [reassigned] = await inbox(colleague);
      expect(reassigned).toMatchObject({ type: 'TASK_ASSIGNED', title: 'Task reassigned to you' });
      expect(await inbox(member)).toHaveLength(1); // only the original assignment
    });

    it('never notifies about your own action, no-ops or unassignments', async () => {
      await assign(member, member.id); // self-assignment
      expect(await inbox(member)).toEqual([]);

      await assign(owner, colleague.id);
      await assign(owner, colleague.id); // same assignee again: changed=false
      await assign(owner, null); // unassigned
      expect(await inbox(colleague)).toHaveLength(1);
      expect(await inbox(owner)).toEqual([]);
    });

    it('creates nothing when the operation fails', async () => {
      expect((await assign(owner, outsider.id)).status).toBe(422); // not a member
      expect((await assign(owner, member.id, UNKNOWN)).status).toBe(404);
      ctx.projects.rows.find((p) => p.id === project)!.status = ProjectStatus.ARCHIVED;
      expect((await assign(owner, member.id)).status).toBe(409);
      expect(ctx.notifications.rows).toEqual([]);
    });
  });

  describe('task comments', () => {
    it('notifies the assignee and the creator once each, never the commenter', async () => {
      await assign(owner, member.id); // creator: owner, assignee: member
      ctx.notifications.rows = [];

      expect((await comment(colleague)).status).toBe(201);
      const [toMember] = await inbox(member);
      const [toOwner] = await inbox(owner);
      expect(toMember).toMatchObject({
        type: 'TASK_COMMENTED',
        title: 'New comment',
        message: 'New comment on “Fix login”, which is assigned to you.',
        actor: { id: colleague.id, email: 'colleague@example.com' },
      });
      expect(toOwner!.message).toBe('New comment on “Fix login”, which you created.');
      expect(await inbox(colleague)).toEqual([]);
      // Comment text never appears in a notification.
      expect(JSON.stringify(ctx.notifications.rows)).not.toContain('Secret note');
    });

    it('notifies a creator who is also the assignee only once', async () => {
      await assign(owner, owner.id);
      await comment(member);
      expect(await inbox(owner)).toHaveLength(1);
    });

    it('skips the commenter when they are the assignee or the creator', async () => {
      await assign(owner, member.id);
      ctx.notifications.rows = [];
      await comment(member); // the assignee comments: only the creator hears
      expect(await inbox(member)).toEqual([]);
      expect(await inbox(owner)).toHaveLength(1);

      const own = await newTask(owner, 'Unassigned');
      await comment(owner, own); // the creator comments on their unassigned task
      expect(await inbox(owner)).toHaveLength(1);
    });

    it('does not notify a creator who left the workspace', async () => {
      const theirs = await newTask(colleague, 'By colleague');
      await authed(
        request(ctx.app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`),
        owner,
      );
      await comment(member, theirs);
      expect(ctx.notifications.rows.filter((r) => r.recipientId === colleague.id)).toEqual([]);
    });
  });

  describe('inbox', () => {
    /** Three notifications for the member, oldest first: two assignments, then a comment. */
    const seed = async () => {
      const t1 = await newTask(owner, 'One');
      await assign(owner, member.id, t1);
      const t2 = await newTask(owner, 'Two');
      await assign(owner, member.id, t2);
      await comment(colleague, t2);
      return (await inbox(member)).map((n) => n.id);
    };

    it('lists newest first with cursor pagination and an unread filter', async () => {
      const all = await seed();
      expect(all).toHaveLength(3);
      const first = await request(ctx.app)
        .get('/api/v1/notifications')
        .query({ limit: '2' })
        .set('Cookie', member.cookie);
      expect(first.body.data.notifications.map((n: { id: string }) => n.id)).toEqual(
        all.slice(0, 2),
      );
      expect(first.body.meta).toEqual({ limit: 2, nextCursor: expect.any(String) });
      const second = await request(ctx.app)
        .get('/api/v1/notifications')
        .query({ limit: '2', cursor: first.body.meta.nextCursor })
        .set('Cookie', member.cookie);
      expect(second.body.data.notifications.map((n: { id: string }) => n.id)).toEqual([all[2]]);
      expect(second.body.meta.nextCursor).toBeNull();

      await authed(request(ctx.app).patch(`/api/v1/notifications/${all[0]}/read`), member);
      expect((await inbox(member, { unreadOnly: 'true' })).map((n) => n.id)).toEqual(all.slice(1));

      // A cursor belongs to its user and its list.
      const foreign = await request(ctx.app)
        .get('/api/v1/notifications')
        .query({ cursor: first.body.meta.nextCursor })
        .set('Cookie', colleague.cookie);
      expect(foreign.status).toBe(400);
      const otherList = await request(ctx.app)
        .get('/api/v1/notifications')
        .query({ unreadOnly: 'true', cursor: first.body.meta.nextCursor })
        .set('Cookie', member.cookie);
      expect(otherList.status).toBe(400);
    });

    it.each([
      [{ limit: '0' }],
      [{ limit: '51' }],
      [{ limit: 'ten' }],
      [{ unreadOnly: 'yes' }],
      [{ cursor: 'not-a-cursor' }],
      [{ recipientId: UNKNOWN }],
    ])('rejects invalid query %j (400)', async (query) => {
      const res = await request(ctx.app)
        .get('/api/v1/notifications')
        .query(query)
        .set('Cookie', member.cookie);
      expect(res.status).toBe(400);
    });

    it('accepts limit 50 and defaults to 20', async () => {
      const at50 = await request(ctx.app)
        .get('/api/v1/notifications')
        .query({ limit: '50' })
        .set('Cookie', member.cookie);
      expect(at50.body.meta.limit).toBe(50);
      const byDefault = await request(ctx.app)
        .get('/api/v1/notifications')
        .set('Cookie', member.cookie);
      expect(byDefault.body.meta.limit).toBe(20);
      expect(byDefault.headers['cache-control']).toBe('no-store');
    });

    it('marks one as read idempotently and keeps the count accurate', async () => {
      const [newest] = await seed();
      expect(await unread(member)).toBe(3);
      const read = () =>
        authed(request(ctx.app).patch(`/api/v1/notifications/${newest}/read`), member);
      const once = await read();
      expect(once.status).toBe(200);
      expect(once.body.data.notification).toMatchObject({ id: newest, isRead: true });
      const twice = await read();
      expect(twice.body.data.notification.readAt).toBe(once.body.data.notification.readAt);
      expect(await unread(member)).toBe(2);
    });

    it('marks all as read', async () => {
      await seed();
      const res = await authed(request(ctx.app).patch('/api/v1/notifications/read-all'), member);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ updated: 3 });
      expect(await unread(member)).toBe(0);
      const again = await authed(request(ctx.app).patch('/api/v1/notifications/read-all'), member);
      expect(again.body.data).toEqual({ updated: 0 });
      expect((await inbox(member)).every((n) => n.isRead && n.readAt)).toBe(true);
    });

    it('deletes one notification (404 when repeated)', async () => {
      const [newest, ...rest] = await seed();
      const remove = () =>
        authed(request(ctx.app).delete(`/api/v1/notifications/${newest}`), member);
      const res = await remove();
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ deleted: true });
      expect((await inbox(member)).map((n) => n.id)).toEqual(rest);
      expect(await unread(member)).toBe(2);
      expect((await remove()).status).toBe(404);
    });

    it('never lets another user read, change or delete a notification', async () => {
      const [theirs] = await seed();
      for (const who of [colleague, outsider, owner]) {
        expect(await inbox(who)).not.toContainEqual(expect.objectContaining({ id: theirs }));
        const read = await authed(
          request(ctx.app).patch(`/api/v1/notifications/${theirs}/read`),
          who,
        );
        const del = await authed(request(ctx.app).delete(`/api/v1/notifications/${theirs}`), who);
        expect(read.status).toBe(404);
        expect(del.status).toBe(404);
        await authed(request(ctx.app).patch('/api/v1/notifications/read-all'), who);
      }
      expect(await unread(member)).toBe(3); // nobody else's read-all touched them
    });

    it('validates ids, rejects extra input and requires the CSRF token', async () => {
      const bad = await authed(
        request(ctx.app).patch('/api/v1/notifications/not-a-uuid/read'),
        member,
      );
      expect(bad.status).toBe(400);
      const body = await authed(
        request(ctx.app).patch('/api/v1/notifications/read-all'),
        member,
      ).send({ recipientId: owner.id });
      expect(body.status).toBe(400);
      const noCsrf = await request(ctx.app)
        .delete(`/api/v1/notifications/${UNKNOWN}`)
        .set('Cookie', member.cookie);
      expect(noCsrf.status).toBe(403);
    });

    it('hides notifications from a workspace the user left, and former actors', async () => {
      await seed();
      await authed(
        request(ctx.app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`),
        owner,
      );
      // The comment by the colleague now shows no actor email.
      const [fromColleague] = await inbox(member);
      expect(fromColleague).toMatchObject({ type: 'TASK_COMMENTED', actor: null });

      await authed(request(ctx.app).delete(`/api/v1/workspaces/${ws}/members/${member.id}`), owner);
      expect(await inbox(member)).toEqual([]);
      expect(await unread(member)).toBe(0);
    });

    it('returns no target when the task no longer exists', async () => {
      await assign(owner, member.id);
      ctx.tasks.rows = ctx.tasks.rows.filter((t) => t.id !== task);
      const [n] = await inbox(member);
      expect(n).toMatchObject({ resourceId: task, target: null });
    });

    it('serves an unavailable database as a generic 503', async () => {
      ctx = await setup(true);
      const user = await ctx.signUp('n@example.com');
      const res = await request(ctx.app).get('/api/v1/notifications').set('Cookie', user.cookie);
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|connection|sql/i);
    });
  });

  it('encodes cursors that only decode for the same user and list', () => {
    const cursor = encodeNotificationCursor(member.id, false, {
      createdAt: new Date('2026-11-04T10:00:00.000Z'),
      id: UNKNOWN,
    });
    expect(Buffer.from(cursor, 'base64url').toString()).toBe(
      `n2:${member.id}|a|${Date.parse('2026-11-04T10:00:00.000Z')}|${UNKNOWN}`,
    );
  });
});
