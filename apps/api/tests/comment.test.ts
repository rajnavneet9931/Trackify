import { Writable } from 'node:stream';

import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { encodeCommentCursor } from '../src/modules/comments/comment-cursor.js';
import {
  buildTestApp,
  InMemoryCommentRepository,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableCommentRepository,
  unreachableWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
const COMMENT_FIELDS = ['author', 'authorId', 'content', 'createdAt', 'id', 'taskId', 'updatedAt'];

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

async function setup(failing = false, logs?: { text: string }) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const workspaces = new InMemoryWorkspaceRepository(users);
  const projects = new InMemoryProjectRepository(workspaces, users);
  const tasks = new InMemoryTaskRepository(projects, workspaces, users);
  const comments = new InMemoryCommentRepository(tasks, workspaces, users);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: sessions,
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
    projectRepository: projects,
    taskRepository: tasks,
    commentRepository: failing ? unreachableCommentRepository : comments,
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
      email,
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: login.body.data.csrfToken,
    };
  };
  return { app, sessions, workspaces, projects, tasks, comments, signUp };
}

describe('task comments API', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let colleague: Account;
  let outsider: Account;
  let ws: string;
  let project: string;
  let task: string;
  let siblingTask: string; // same project
  let otherWs: string;
  let foreignProject: string;
  let foreignTask: string;

  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const base = (taskId = task, workspaceId = ws, projectId = project) =>
    `/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}/comments`;
  const post = (who: Account, body: object, taskId = task, workspaceId = ws, projectId = project) =>
    authed(request(ctx.app).post(base(taskId, workspaceId, projectId)), who).send(body);
  const list = (
    who: Account,
    query: Record<string, string> = {},
    taskId = task,
    workspaceId = ws,
    projectId = project,
  ) =>
    request(ctx.app)
      .get(base(taskId, workspaceId, projectId))
      .query(query)
      .set('Cookie', who.cookie);
  const edit = (
    who: Account,
    commentId: string,
    body: object,
    taskId = task,
    workspaceId = ws,
    projectId = project,
  ) =>
    authed(
      request(ctx.app).patch(`${base(taskId, workspaceId, projectId)}/${commentId}`),
      who,
    ).send(body);
  const remove = (
    who: Account,
    commentId: string,
    taskId = task,
    workspaceId = ws,
    projectId = project,
  ) => authed(request(ctx.app).delete(`${base(taskId, workspaceId, projectId)}/${commentId}`), who);
  const row = (id: string) => ctx.comments.rows.find((c) => c.id === id);
  const seen = (id: string) => ({ expectedUpdatedAt: row(id)!.updatedAt.toISOString() });
  const comment = async (who: Account, content: string, taskId = task) =>
    (await post(who, { content }, taskId)).body.data.comment.id as string;
  const archive = () =>
    authed(request(ctx.app).post(`/api/v1/workspaces/${ws}/projects/${project}/archive`), owner);

  /** Seeds comments directly, one second apart (oldest first). */
  const seed = (taskId: string, count: number, start = Date.UTC(2026, 10, 1)) => {
    for (let i = 0; i < count; i++) {
      const at = new Date(start + i * 1000);
      ctx.comments.rows.push({
        id: `01a14e7b-cea3-700d-aeda-${String(ctx.comments.rows.length + 200).padStart(12, '0')}`,
        taskId,
        authorId: member.id,
        content: `Comment ${i}`,
        createdAt: at,
        updatedAt: at,
      });
    }
  };
  const allPages = async (who: Account, limit: number, taskId = task) => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const res = await list(who, { limit: String(limit), ...(cursor && { cursor }) }, taskId);
      expect(res.status).toBe(200);
      pages.push(res.body.data.comments.map((c: { id: string }) => c.id));
      cursor = res.body.meta.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  };

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
    const newTask = async (by: Account, workspaceId: string, projectId: string) =>
      (
        await authed(
          request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`),
          by,
        ).send({ title: 'Task' })
      ).body.data.task.id as string;
    ws = await newWorkspace(owner);
    otherWs = await newWorkspace(outsider);
    ctx.workspaces.addMember(ws, member.id);
    ctx.workspaces.addMember(ws, colleague.id);
    project = await newProject(owner, ws);
    foreignProject = await newProject(outsider, otherWs);
    task = await newTask(owner, ws, project);
    siblingTask = await newTask(owner, ws, project);
    foreignTask = await newTask(outsider, otherWs, foreignProject);
  });

  describe('POST (create)', () => {
    it.each([
      ['the owner', () => owner],
      ['a regular member', () => member],
    ])('lets %s comment; author from the session, task from the URL', async (_l, who) => {
      const res = await post(who(), { content: '  Looks good!\nShip it.  ' });

      expect(res.status).toBe(201);
      expect(Object.keys(res.body.data.comment).sort()).toEqual(COMMENT_FIELDS);
      expect(res.body.data.comment).toMatchObject({
        taskId: task,
        authorId: who().id,
        author: { id: who().id, email: who().email },
        content: 'Looks good!\nShip it.',
      });
      expect(Object.keys(res.body.data.comment.author).sort()).toEqual(['email', 'id']);
    });

    it('accepts exactly 5000 characters', async () => {
      expect((await post(member, { content: 'c'.repeat(5000) })).status).toBe(201);
    });

    it.each([
      ['missing content', {}],
      ['empty content', { content: '' }],
      ['whitespace-only content', { content: ' \n ' }],
      ['oversized content', { content: 'c'.repeat(5001) }],
      ['non-string content', { content: 5 }],
      ['control characters', { content: 'bad\u0007bell' }],
      ['a client userId', { content: 'x', userId: UNKNOWN }],
      ['a client authorId', { content: 'x', authorId: UNKNOWN }],
      ['a client taskId', { content: 'x', taskId: UNKNOWN }],
      ['an unknown field', { content: 'x', pinned: true }],
    ])('rejects %s with 400 and stores nothing', async (_l, body) => {
      const res = await post(member, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(ctx.comments.rows).toHaveLength(0);
    });

    it('refuses archived projects with 409', async () => {
      await archive();
      const res = await post(member, { content: 'Too late' });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(
        'This project is archived. Its discussion is read-only until it is restored.',
      );
      expect(ctx.comments.rows).toHaveLength(0);
    });

    it('answers outsiders, unknown and cross-hierarchy targets with 404', async () => {
      const results = [
        await post(outsider, { content: 'x' }),
        await post(owner, { content: 'x' }, UNKNOWN),
        await post(owner, { content: 'x' }, foreignTask), // foreign task via our project
        await post(owner, { content: 'x' }, task, ws, foreignProject), // foreign project
        await post(owner, { content: 'x' }, task, UNKNOWN), // unknown workspace
        await post(outsider, { content: 'x' }, task, otherWs, foreignProject), // our task via theirs
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
      expect(ctx.comments.rows).toHaveLength(0);
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await authed(request(ctx.app).post(base()), member)
        .type('form')
        .send('content=x');
      expect(res.status).toBe(415);
    });
  });

  describe('GET (list)', () => {
    it.each([
      ['the owner', () => owner],
      ['a regular member', () => member],
    ])('lets %s read the discussion, oldest first, safe fields only', async (_l, who) => {
      seed(task, 3);
      seed(siblingTask, 2);

      const res = await list(who());

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.meta).toEqual({ limit: 20, nextCursor: null });
      expect(res.body.data.comments.map((c: { content: string }) => c.content)).toEqual([
        'Comment 0',
        'Comment 1',
        'Comment 2',
      ]);
      for (const c of res.body.data.comments) {
        expect(Object.keys(c).sort()).toEqual(COMMENT_FIELDS);
        expect(c.taskId).toBe(task);
        expect(c.author).toEqual({ id: member.id, email: member.email });
      }
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session|token/i);
    });

    it('returns an empty list for a task without comments', async () => {
      expect((await list(member)).body).toEqual({
        data: { comments: [] },
        meta: { limit: 20, nextCursor: null },
      });
    });

    it('keeps comments readable in archived projects', async () => {
      seed(task, 2);
      await archive();
      const res = await list(member);
      expect(res.status).toBe(200);
      expect(res.body.data.comments).toHaveLength(2);
    });

    it('answers outsiders and cross-hierarchy targets with 404, leaking nothing', async () => {
      seed(foreignTask, 1);
      const results = [
        await list(outsider),
        await list(owner, {}, foreignTask),
        await list(owner, {}, task, ws, foreignProject),
        await list(owner, {}, UNKNOWN),
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404]);
      expect(JSON.stringify(results.map((r) => r.body))).not.toContain('Comment 0');
    });

    it('defaults to 20 per page and allows at most 50', async () => {
      seed(task, 60);
      const byDefault = await list(member);
      expect(byDefault.body.data.comments).toHaveLength(20);
      expect(byDefault.body.meta.nextCursor).toEqual(expect.any(String));
      expect((await list(member, { limit: '50' })).body.data.comments).toHaveLength(50);
      for (const limit of ['0', '51', 'x', '1.5']) {
        expect((await list(member, { limit })).status).toBe(400);
      }
    });

    it('pages chronologically through every comment exactly once', async () => {
      seed(task, 7);
      const pages = await allPages(member, 3);
      expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
      expect(pages.flat()).toEqual(ctx.comments.rows.map((c) => c.id));
    });

    it('orders equal timestamps by id ASC deterministically', async () => {
      for (let i = 0; i < 5; i++) seed(task, 1, Date.UTC(2026, 10, 2));
      const first = await allPages(member, 2);
      expect(first.flat()).toEqual(ctx.comments.rows.map((c) => c.id).sort());
      expect(await allPages(member, 2)).toEqual(first);
    });

    it('rejects a cursor issued for another task, and malformed or tampered cursors', async () => {
      seed(task, 3);
      seed(siblingTask, 3);
      const fromSibling = (await list(member, { limit: '1' }, siblingTask)).body.meta.nextCursor;
      expect((await list(member, { cursor: fromSibling })).status).toBe(400);
      const valid = (await list(member, { limit: '1' })).body.meta.nextCursor as string;
      for (const cursor of [
        '!!!',
        `${valid.slice(0, -3)}AAA`,
        Buffer.from(`t1:${task}|1|${UNKNOWN}`).toString('base64url'),
        Buffer.from(`c1:${task}|soon|${UNKNOWN}`).toString('base64url'),
      ]) {
        expect((await list(member, { cursor })).status).toBe(400);
      }
      const ok = encodeCommentCursor(task, {
        createdAt: new Date(Date.UTC(2026, 10, 1) + 500), // between comments 0 and 1
        id: UNKNOWN,
      });
      expect((await list(member, { cursor: ok })).body.data.comments).toHaveLength(2);
    });

    it('shows a new comment last; hides the email of an author who left', async () => {
      await comment(colleague, 'First');
      await comment(member, 'Second');
      await authed(
        request(ctx.app).delete(`/api/v1/workspaces/${ws}/members/${colleague.id}`),
        owner,
      );

      const res = await list(owner);
      expect(res.body.data.comments.map((c: { content: string }) => c.content)).toEqual([
        'First',
        'Second',
      ]);
      expect(res.body.data.comments[0]).toMatchObject({ authorId: colleague.id, author: null });
      expect(JSON.stringify(res.body)).not.toContain('colleague@example.com');
    });
  });

  describe('PATCH (edit)', () => {
    it.each([
      ['a member', () => member],
      ['the owner', () => owner],
    ])('lets %s edit their own comment; updatedAt moves forward', async (_l, who) => {
      const id = await comment(who(), 'Original');
      const before = { ...row(id)! };

      const res = await edit(who(), id, { content: '  Edited  ', ...seen(id) });

      expect(res.status).toBe(200);
      expect(res.body.data.comment).toMatchObject({
        id,
        content: 'Edited',
        authorId: who().id,
        createdAt: before.createdAt.toISOString(),
      });
      expect(row(id)!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });

    it.each([
      ['another member', () => colleague],
      ['a workspace owner', () => owner],
    ])('refuses edits by %s to someone else’s comment (403)', async (_l, who) => {
      const id = await comment(member, 'Mine');
      const before = { ...row(id)! };
      const res = await edit(who(), id, { content: 'Hijacked', ...seen(id) });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('You can only edit your own comments.');
      expect(row(id)).toEqual(before);
    });

    it('rejects a stale edit with 409 instead of overwriting', async () => {
      const id = await comment(member, 'Original');
      const version = seen(id);
      expect((await edit(member, id, { content: 'First', ...version })).status).toBe(200);

      const second = await edit(member, id, { content: 'Second', ...version });
      expect(second.status).toBe(409);
      expect(second.body.error.message).toContain('changed meanwhile');
      expect(row(id)!.content).toBe('First');
    });

    it.each([
      ['empty content', { content: '' }],
      ['oversized content', { content: 'c'.repeat(5001) }],
      ['a missing expectedUpdatedAt', { content: 'x', expectedUpdatedAt: undefined }],
      ['an invalid expectedUpdatedAt', { content: 'x', expectedUpdatedAt: 'later' }],
      ['an authorId', { content: 'x', authorId: UNKNOWN }],
      ['a taskId', { content: 'x', taskId: UNKNOWN }],
      ['a createdAt', { content: 'x', createdAt: '2020-01-01T00:00:00.000Z' }],
    ])('rejects %s with 400', async (_l, body) => {
      const id = await comment(member, 'Original');
      const res = await edit(member, id, { ...seen(id), ...body });
      expect(res.status).toBe(400);
      expect(row(id)!.content).toBe('Original');
    });

    it('refuses edits in archived projects (409)', async () => {
      const id = await comment(member, 'Original');
      await archive();
      const res = await edit(member, id, { content: 'Edited', ...seen(id) });
      expect(res.status).toBe(409);
      expect(row(id)!.content).toBe('Original');
    });

    it('answers unknown comments and cross-hierarchy targets with 404', async () => {
      const id = await comment(member, 'Original');
      const body = { content: 'x', ...seen(id) };
      const results = [
        await edit(member, UNKNOWN, body),
        await edit(member, id, body, siblingTask), // right project, wrong task
        await edit(member, id, body, foreignTask),
        await edit(outsider, id, body),
        await edit(outsider, id, body, foreignTask, otherWs, foreignProject),
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
      expect(row(id)!.content).toBe('Original');
    });
  });

  describe('DELETE', () => {
    it('lets authors delete their own comment; a repeat gets 404', async () => {
      const id = await comment(member, 'Bye');
      const res = await remove(member, id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { deleted: true } });
      expect(row(id)).toBeUndefined();
      expect((await remove(member, id)).status).toBe(404);
    });

    it('lets a workspace OWNER delete another member’s comment', async () => {
      const id = await comment(member, 'Moderated');
      const keep = await comment(colleague, 'Stays');
      expect((await remove(owner, id)).status).toBe(200);
      expect(row(id)).toBeUndefined();
      expect(row(keep)).toBeDefined();
    });

    it('refuses a MEMBER deleting another member’s comment (403)', async () => {
      const id = await comment(colleague, 'Not yours');
      const res = await remove(member, id);
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('You can only delete your own comments.');
      expect(row(id)).toBeDefined();
    });

    it('refuses deletes in archived projects (409), even for owners', async () => {
      const id = await comment(member, 'Frozen');
      await archive();
      expect((await remove(member, id)).status).toBe(409);
      expect((await remove(owner, id)).status).toBe(409);
      expect(row(id)).toBeDefined();
    });

    it('cannot delete across tasks, projects or workspaces', async () => {
      const id = await comment(member, 'Here');
      const results = [
        await remove(owner, id, siblingTask),
        await remove(owner, id, foreignTask),
        await remove(outsider, id),
        await remove(outsider, id, foreignTask, otherWs, foreignProject),
      ];
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404]);
      expect(row(id)).toBeDefined();
    });

    it('rejects body fields and query parameters', async () => {
      const id = await comment(member, 'Here');
      expect((await remove(member, id).send({ force: true })).status).toBe(400);
      expect((await remove(member, id).query({ force: '1' })).status).toBe(400);
      expect(row(id)).toBeDefined();
    });
  });

  describe('security', () => {
    it('requires a session everywhere; rejects expired and revoked sessions', async () => {
      const id = await comment(member, 'Here');
      const anonymous = [
        await request(ctx.app).get(base()),
        await request(ctx.app).post(base()).send({ content: 'x' }),
        await request(ctx.app)
          .patch(`${base()}/${id}`)
          .send({ content: 'x', ...seen(id) }),
        await request(ctx.app).delete(`${base()}/${id}`),
      ];
      expect(anonymous.map((r) => r.status)).toEqual([401, 401, 401, 401]);

      ctx.sessions.rows.find((s) => s.userId === member.id)!.expiresAt = new Date(Date.now() - 1);
      expect((await list(member)).status).toBe(401);
      expect((await remove(member, id)).status).toBe(401);
      await authed(request(ctx.app).post('/api/v1/auth/logout'), colleague);
      expect((await post(colleague, { content: 'x' })).status).toBe(401);
      expect(row(id)).toBeDefined();
    });

    it('requires a valid CSRF token and an allowed Origin for every mutation', async () => {
      const id = await comment(member, 'Here');
      const calls = [
        () => request(ctx.app).post(base()).send({ content: 'x' }),
        () =>
          request(ctx.app)
            .patch(`${base()}/${id}`)
            .send({ content: 'x', ...seen(id) }),
        () => request(ctx.app).delete(`${base()}/${id}`),
      ];
      for (const call of calls) {
        expect((await call().set('Cookie', member.cookie)).status).toBe(403);
        expect(
          (await call().set('Cookie', member.cookie).set('X-CSRF-Token', owner.csrfToken)).status,
        ).toBe(403);
        expect(
          (
            await call()
              .set('Cookie', member.cookie)
              .set('X-CSRF-Token', member.csrfToken)
              .set('Origin', 'https://evil.example')
          ).status,
        ).toBe(403);
      }
      expect(ctx.comments.rows).toHaveLength(1);
      expect(row(id)!.content).toBe('Here');
    });

    it('rejects malformed UUIDs', async () => {
      const results = [
        await list(member, {}, 'nope'),
        await post(member, { content: 'x' }, task, 'nope'),
        await edit(member, 'nope', { content: 'x', expectedUpdatedAt: new Date().toISOString() }),
        await remove(member, 'nope'),
      ];
      expect(results.map((r) => r.status)).toEqual([400, 400, 400, 400]);
    });

    it('returns a generic 503 when the database is unavailable', async () => {
      const failing = await setup(true);
      const account = await failing.signUp('carol@example.com');
      const path = base(UNKNOWN, UNKNOWN, UNKNOWN);
      const send = <T extends request.Test>(req: T) =>
        req.set('Cookie', account.cookie).set('X-CSRF-Token', account.csrfToken);
      const responses = [
        await send(request(failing.app).get(path)),
        await send(request(failing.app).post(path)).send({ content: 'x' }),
        await send(request(failing.app).patch(`${path}/${UNKNOWN}`)).send({
          content: 'x',
          expectedUpdatedAt: new Date().toISOString(),
        }),
        await send(request(failing.app).delete(`${path}/${UNKNOWN}`)),
      ];
      for (const res of responses) {
        expect(res.status).toBe(503);
        expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
      }
    });

    it('never logs tokens, passwords or comment content', async () => {
      const logs = { text: '' };
      const logged = await setup(false, logs);
      const boss = await logged.signUp('boss@example.com');
      const send = <T extends request.Test>(req: T) =>
        req.set('Cookie', boss.cookie).set('X-CSRF-Token', boss.csrfToken);
      const w = (await send(request(logged.app).post('/api/v1/workspaces')).send({ name: 'T' }))
        .body.data.workspace.id;
      const p = (
        await send(request(logged.app).post(`/api/v1/workspaces/${w}/projects`)).send({ name: 'P' })
      ).body.data.project.id;
      const t = (
        await send(request(logged.app).post(`/api/v1/workspaces/${w}/projects/${p}/tasks`)).send({
          title: 'T',
        })
      ).body.data.task.id;
      const path = `/api/v1/workspaces/${w}/projects/${p}/tasks/${t}/comments`;
      const created = (
        await send(request(logged.app).post(path)).send({ content: 'Secret remark' })
      ).body.data.comment;
      await send(request(logged.app).get(path));
      await send(request(logged.app).patch(`${path}/${created.id}`)).send({
        content: 'Even more secret',
        expectedUpdatedAt: created.updatedAt,
      });
      await send(request(logged.app).delete(`${path}/${created.id}`));

      expect(logs.text).toContain('/comments');
      for (const secret of [
        boss.cookie.split('=')[1]!,
        boss.csrfToken,
        PASSWORD,
        'Secret remark',
        'Even more secret',
      ]) {
        expect(logs.text).not.toContain(secret);
      }
    });
  });
});
