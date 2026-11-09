import { Writable } from 'node:stream';

import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableProjectRepository,
  unreachableWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';
const PROJECT_FIELDS = [
  'createdAt',
  'createdById',
  'description',
  'id',
  'name',
  'status',
  'updatedAt',
  'workspaceId',
];

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

async function setup(failing = false, logs?: { text: string }) {
  const users = new InMemoryUserRepository();
  const workspaces = new InMemoryWorkspaceRepository(users);
  const projects = new InMemoryProjectRepository(workspaces, users);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: new InMemorySessionRepository(users),
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
    projectRepository: failing ? unreachableProjectRepository : projects,
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
  return { app, workspaces, projects, signUp };
}

describe('project lifecycle (details, edit, archive, restore, delete)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;
  let otherWs: string;
  let project: { id: string; updatedAt: string };
  let otherProject: string;

  const base = (workspaceId: string, projectId: string) =>
    `/api/v1/workspaces/${workspaceId}/projects/${projectId}`;
  const get = (who: Account, workspaceId = ws, projectId = project.id) =>
    request(ctx.app).get(base(workspaceId, projectId)).set('Cookie', who.cookie);
  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const patch = (who: Account, body: object, workspaceId = ws, projectId = project.id) =>
    authed(request(ctx.app).patch(base(workspaceId, projectId)), who).send(body);
  const action = (
    who: Account,
    verb: 'archive' | 'restore',
    workspaceId = ws,
    projectId = project.id,
  ) => authed(request(ctx.app).post(`${base(workspaceId, projectId)}/${verb}`), who);
  const remove = (who: Account, workspaceId = ws, projectId = project.id) =>
    authed(request(ctx.app).delete(base(workspaceId, projectId)), who);
  const row = (id = project.id) => ctx.projects.rows.find((r) => r.id === id);
  const fresh = () => ({ expectedUpdatedAt: row()!.updatedAt.toISOString() });

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    const newWorkspace = async (by: Account, name: string) =>
      (await authed(request(ctx.app).post('/api/v1/workspaces'), by).send({ name })).body.data
        .workspace.id as string;
    const newProject = async (by: Account, workspaceId: string, name: string) =>
      (
        await authed(request(ctx.app).post(`/api/v1/workspaces/${workspaceId}/projects`), by).send({
          name,
          description: 'Original description',
        })
      ).body.data.project;
    ws = await newWorkspace(owner, 'Team');
    otherWs = await newWorkspace(outsider, 'Elsewhere');
    ctx.workspaces.addMember(ws, member.id);
    project = await newProject(owner, ws, 'Website Redesign');
    otherProject = (await newProject(outsider, otherWs, 'Their project')).id;
  });

  describe('GET details', () => {
    it.each([
      ['the owner', () => owner],
      ['a regular member', () => member],
    ])('lets %s view a project with safe fields and its creator', async (_label, who) => {
      const res = await get(who());

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.body.data).sort()).toEqual(['creator', 'project']);
      expect(Object.keys(res.body.data.project).sort()).toEqual(PROJECT_FIELDS);
      expect(res.body.data.project).toMatchObject({
        id: project.id,
        workspaceId: ws,
        name: 'Website Redesign',
        status: 'ACTIVE',
        createdById: owner.id,
      });
      expect(res.body.data.creator).toEqual({ id: owner.id, email: 'owner@example.com' });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session|token/i);
    });

    it('needs no CSRF token', async () => {
      expect((await get(member)).status).toBe(200);
    });

    it('hides the creator once they left the workspace (authorship id kept)', async () => {
      const created = await authed(
        request(ctx.app).post(`/api/v1/workspaces/${ws}/projects`),
        owner,
      ).send({ name: 'Owned' });
      ctx.workspaces.members.splice(
        ctx.workspaces.members.findIndex((m) => m.workspaceId === ws && m.userId === owner.id),
        1,
      );
      ctx.workspaces.members.find((m) => m.workspaceId === ws && m.userId === member.id)!.role =
        'OWNER';
      const res = await get(member, ws, created.body.data.project.id);

      expect(res.body.data.creator).toBeNull();
      expect(res.body.data.project.createdById).toBe(owner.id);
    });

    it('answers outsiders, unknown workspaces, unknown and foreign projects with 404', async () => {
      const outsiderRes = await get(outsider);
      const unknownWs = await get(owner, UNKNOWN);
      const unknownProject = await get(owner, ws, UNKNOWN);
      const foreign = await get(owner, ws, otherProject); // exists, but in another workspace

      expect([outsiderRes, unknownWs, unknownProject, foreign].map((r) => r.status)).toEqual([
        404, 404, 404, 404,
      ]);
      expect({ ...outsiderRes.body.error, requestId: 0 }).toEqual({
        ...unknownWs.body.error,
        requestId: 0,
      });
      expect(unknownProject.body.error.message).toBe('Project not found');
      expect({ ...foreign.body.error, requestId: 0 }).toEqual({
        ...unknownProject.body.error,
        requestId: 0,
      });
      expect(JSON.stringify(foreign.body)).not.toContain('Their project');
    });

    it('keeps archived projects viewable', async () => {
      await action(owner, 'archive');
      const res = await get(member);
      expect(res.status).toBe(200);
      expect(res.body.data.project.status).toBe('ARCHIVED');
    });

    it.each([
      ['a malformed workspace id', () => get(owner, 'nope')],
      ['a malformed project id', () => get(owner, ws, 'nope')],
      ['a query parameter', () => get(owner).query({ expand: 'all' })],
    ])('rejects %s with 400', async (_label, call) => {
      expect((await call()).status).toBe(400);
    });
  });

  describe('PATCH (edit)', () => {
    it.each([
      [
        'the name',
        { name: '  New Name  ' },
        { name: 'New Name', description: 'Original description' },
      ],
      [
        'the description',
        { description: '  New text ' },
        { name: 'Website Redesign', description: 'New text' },
      ],
      [
        'both',
        { name: 'Both', description: 'Both too' },
        { name: 'Both', description: 'Both too' },
      ],
      [
        'to clear the description',
        { description: '' },
        { name: 'Website Redesign', description: null },
      ],
      [
        'to clear it with null',
        { description: null },
        { name: 'Website Redesign', description: null },
      ],
    ])('lets the owner update %s', async (_label, change, expected) => {
      const before = { ...row()! };
      const res = await patch(owner, { ...change, ...fresh() });

      expect(res.status).toBe(200);
      expect(res.body.data.project).toMatchObject({
        ...expected,
        status: 'ACTIVE',
        id: project.id,
      });
      expect(Object.keys(res.body.data.project).sort()).toEqual(PROJECT_FIELDS);
      expect(new Date(res.body.data.project.updatedAt).getTime()).toBeGreaterThan(
        before.updatedAt.getTime(),
      );
      expect(res.body.data.project.createdAt).toBe(before.createdAt.toISOString());
      expect(row()).toMatchObject(expected);
    });

    it.each([
      ['a MEMBER', () => member, 403, 'FORBIDDEN'],
      ['an outsider', () => outsider, 404, 'NOT_FOUND'],
    ])('refuses %s and changes nothing', async (_label, who, status, code) => {
      const before = { ...row()! };
      const res = await patch(who(), { name: 'Hijack', ...fresh() });

      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(row()).toEqual(before);
    });

    it('answers an unknown workspace and a foreign project with 404', async () => {
      expect((await patch(owner, { name: 'X', ...fresh() }, UNKNOWN)).status).toBe(404);
      const foreign = await patch(owner, { name: 'X', ...fresh() }, ws, otherProject);
      expect(foreign.status).toBe(404);
      expect(row(otherProject)!.name).toBe('Their project');
    });

    it.each([
      ['an empty name', { name: '' }],
      ['a whitespace-only name', { name: '   ' }],
      ['a name over 120 characters', { name: 'n'.repeat(121) }],
      ['a description over 2000 characters', { description: 'd'.repeat(2001) }],
      ['no editable field', {}],
      ['an unknown field', { name: 'X', color: 'red' }],
      ['an id', { name: 'X', id: UNKNOWN }],
      ['a workspaceId', { name: 'X', workspaceId: UNKNOWN }],
      ['a createdById', { name: 'X', createdById: UNKNOWN }],
      ['a status', { name: 'X', status: 'ARCHIVED' }],
      ['a createdAt', { name: 'X', createdAt: '2020-01-01T00:00:00.000Z' }],
      ['an updatedAt', { name: 'X', updatedAt: '2020-01-01T00:00:00.000Z' }],
    ])('rejects %s with 400 and changes nothing', async (_label, body) => {
      const before = { ...row()! };
      const res = await patch(owner, { ...body, ...fresh() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(row()).toEqual(before);
    });

    it.each([
      ['missing', {}],
      ['not a timestamp', { expectedUpdatedAt: 'yesterday' }],
    ])('rejects a %s expectedUpdatedAt with 400', async (_label, precondition) => {
      expect((await patch(owner, { name: 'X', ...precondition })).status).toBe(400);
    });

    it('accepts the length boundaries', async () => {
      const res = await patch(owner, {
        name: 'n'.repeat(120),
        description: 'd'.repeat(2000),
        ...fresh(),
      });
      expect(res.status).toBe(200);
    });

    it('rejects a stale edit with 409 instead of overwriting the newer change', async () => {
      const seen = fresh(); // two owners loaded the same version
      expect((await patch(owner, { name: 'First', ...seen })).status).toBe(200);

      const second = await patch(owner, { name: 'Second', ...seen });

      expect(second.status).toBe(409);
      expect(second.body.error.message).toBe(
        'This project was changed by someone else. Reload it to see the latest version.',
      );
      expect(row()!.name).toBe('First');
    });

    it('keeps archived projects read-only (409) until restored', async () => {
      await action(owner, 'archive');
      const before = { ...row()! };

      const res = await patch(owner, { name: 'Edited while archived', ...fresh() });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(
        'Archived projects are read-only. Restore the project to edit it.',
      );
      expect(row()).toEqual(before);

      await action(owner, 'restore');
      expect((await patch(owner, { name: 'Edited after restore', ...fresh() })).status).toBe(200);
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await authed(request(ctx.app).patch(base(ws, project.id)), owner)
        .type('form')
        .send('name=X');
      expect(res.status).toBe(415);
    });
  });

  describe('archive and restore', () => {
    it('owner archives: status ARCHIVED, record and details kept, updatedAt moves forward', async () => {
      const before = { ...row()! };
      const res = await action(owner, 'archive');

      expect(res.status).toBe(200);
      expect(res.body.data.changed).toBe(true);
      expect(res.body.data.project).toMatchObject({
        id: project.id,
        status: 'ARCHIVED',
        name: before.name,
        description: before.description,
        createdAt: before.createdAt.toISOString(),
      });
      expect(row()).toMatchObject({ status: 'ARCHIVED', name: before.name });
      expect(row()!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });

    it('archiving twice is idempotent (200, changed: false, nothing written)', async () => {
      await action(owner, 'archive');
      const before = { ...row()! };

      const again = await action(owner, 'archive');

      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ changed: false, project: { status: 'ARCHIVED' } });
      expect(row()).toEqual(before);
    });

    it('owner restores an archived project; restoring again is idempotent', async () => {
      await action(owner, 'archive');
      const archived = { ...row()! };

      const restored = await action(owner, 'restore');
      expect(restored.status).toBe(200);
      expect(restored.body.data).toMatchObject({ changed: true, project: { status: 'ACTIVE' } });
      expect(row()!.updatedAt.getTime()).toBeGreaterThan(archived.updatedAt.getTime());

      const again = await action(owner, 'restore');
      expect(again.body.data).toMatchObject({ changed: false, project: { status: 'ACTIVE' } });
    });

    it.each([
      ['a MEMBER', () => member, 403],
      ['an outsider', () => outsider, 404],
    ])('refuses %s for both actions', async (_label, who, status) => {
      expect((await action(who(), 'archive')).status).toBe(status);
      expect(row()!.status).toBe('ACTIVE');
      await action(owner, 'archive');
      expect((await action(who(), 'restore')).status).toBe(status);
      expect(row()!.status).toBe('ARCHIVED');
    });

    it('cannot touch another workspace’s project and 404s unknown projects', async () => {
      expect((await action(owner, 'archive', ws, otherProject)).status).toBe(404);
      expect((await action(owner, 'archive', ws, UNKNOWN)).status).toBe(404);
      expect(row(otherProject)!.status).toBe('ACTIVE');
    });

    it('rejects body fields and query parameters', async () => {
      expect((await action(owner, 'archive').send({ status: 'ACTIVE' })).status).toBe(400);
      expect((await action(owner, 'archive').query({ force: 'true' })).status).toBe(400);
      expect(row()!.status).toBe('ACTIVE');
    });

    it('interleaved concurrent archive/restore requests always leave a valid state', async () => {
      const results = await Promise.all([
        action(owner, 'archive'),
        action(owner, 'restore'),
        action(owner, 'archive'),
        action(owner, 'restore'),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(['ACTIVE', 'ARCHIVED']).toContain(row()!.status);
    });
  });

  describe('DELETE (permanent)', () => {
    it('owner deletes only that project; workspace, members and other projects stay', async () => {
      const sibling = (
        await authed(request(ctx.app).post(`/api/v1/workspaces/${ws}/projects`), owner).send({
          name: 'Sibling',
        })
      ).body.data.project.id;
      const membersBefore = ctx.workspaces.members.length;

      const res = await remove(owner);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { deleted: true } });
      expect(row()).toBeUndefined();
      expect(row(sibling)).toBeDefined();
      expect(row(otherProject)).toBeDefined();
      expect(ctx.workspaces.members.length).toBe(membersBefore);
      expect((await get(owner)).status).toBe(404);
      expect((await get(owner, ws, sibling)).status).toBe(200);
    });

    it('can delete an archived project too', async () => {
      await action(owner, 'archive');
      expect((await remove(owner)).status).toBe(200);
      expect(row()).toBeUndefined();
    });

    it('answers a repeated delete with 404', async () => {
      expect((await remove(owner)).status).toBe(200);
      const again = await remove(owner);
      expect(again.status).toBe(404);
      expect(again.body.error.message).toBe('Project not found');
    });

    it.each([
      ['a MEMBER', () => member, 403],
      ['an outsider', () => outsider, 404],
    ])('refuses %s and keeps the project', async (_label, who, status) => {
      expect((await remove(who())).status).toBe(status);
      expect(row()).toBeDefined();
    });

    it('cannot delete across workspaces', async () => {
      expect((await remove(owner, ws, otherProject)).status).toBe(404);
      expect((await remove(outsider, otherWs, project.id)).status).toBe(404);
      expect(row()).toBeDefined();
      expect(row(otherProject)).toBeDefined();
    });

    it('rejects body fields and query parameters', async () => {
      expect((await remove(owner).send({ confirm: true })).status).toBe(400);
      expect((await remove(owner).query({ cascade: 'true' })).status).toBe(400);
      expect(row()).toBeDefined();
    });
  });

  describe('security', () => {
    const mutations = () =>
      [
        [
          'PATCH',
          (r: request.SuperTest<request.Test>) =>
            r.patch(base(ws, project.id)).send({ name: 'X', ...fresh() }),
        ],
        [
          'archive',
          (r: request.SuperTest<request.Test>) => r.post(`${base(ws, project.id)}/archive`),
        ],
        [
          'restore',
          (r: request.SuperTest<request.Test>) => r.post(`${base(ws, project.id)}/restore`),
        ],
        ['DELETE', (r: request.SuperTest<request.Test>) => r.delete(base(ws, project.id))],
      ] as const;

    it('requires a session for every endpoint', async () => {
      expect((await request(ctx.app).get(base(ws, project.id))).status).toBe(401);
      for (const [, call] of mutations()) {
        expect((await call(request(ctx.app) as never)).status).toBe(401);
      }
    });

    it('requires a valid CSRF token and an allowed Origin for every mutation', async () => {
      const before = { ...row()! };
      for (const [, call] of mutations()) {
        const app = request(ctx.app) as never;
        expect((await call(app).set('Cookie', owner.cookie)).status).toBe(403);
        expect(
          (
            await call(request(ctx.app) as never)
              .set('Cookie', owner.cookie)
              .set('X-CSRF-Token', member.csrfToken)
          ).status,
        ).toBe(403);
        expect(
          (
            await call(request(ctx.app) as never)
              .set('Cookie', owner.cookie)
              .set('X-CSRF-Token', owner.csrfToken)
              .set('Origin', 'https://evil.example')
          ).status,
        ).toBe(403);
      }
      expect(row()).toEqual(before);
    });

    it('never logs session tokens, CSRF tokens, passwords or project content', async () => {
      const logs = { text: '' };
      const logged = await setup(false, logs);
      const boss = await logged.signUp('boss@example.com');
      const send = <T extends request.Test>(req: T) =>
        req.set('Cookie', boss.cookie).set('X-CSRF-Token', boss.csrfToken);
      const workspaceId = (
        await send(request(logged.app).post('/api/v1/workspaces')).send({ name: 'Team' })
      ).body.data.workspace.id;
      const created = (
        await send(request(logged.app).post(`/api/v1/workspaces/${workspaceId}/projects`)).send({
          name: 'Secret Codename',
          description: 'Confidential plans',
        })
      ).body.data.project;
      const projectPath = base(workspaceId, created.id);

      await send(request(logged.app).get(projectPath));
      await send(request(logged.app).patch(projectPath)).send({
        description: 'Even more confidential',
        expectedUpdatedAt: created.updatedAt,
      });
      await send(request(logged.app).post(`${projectPath}/archive`));
      await send(request(logged.app).post(`${projectPath}/restore`));
      await send(request(logged.app).delete(projectPath));

      expect(logs.text).toContain('/projects/'); // requests were logged…
      for (const secret of [
        boss.cookie.split('=')[1]!,
        boss.csrfToken,
        PASSWORD,
        'Secret Codename',
        'Confidential plans',
        'Even more confidential',
      ]) {
        expect(logs.text).not.toContain(secret); // …without sensitive data
      }
    });

    it('rejects malformed UUIDs on every mutation', async () => {
      expect((await patch(owner, { name: 'X', ...fresh() }, ws, 'nope')).status).toBe(400);
      expect((await action(owner, 'archive', 'nope')).status).toBe(400);
      expect((await action(owner, 'restore', ws, 'nope')).status).toBe(400);
      expect((await remove(owner, ws, 'nope')).status).toBe(400);
    });

    it('returns a generic 503 for every endpoint when the database is unavailable', async () => {
      const failing = await setup(true);
      const account = await failing.signUp('carol@example.com');
      const path = base(UNKNOWN, UNKNOWN);
      const responses = [
        await request(failing.app).get(path).set('Cookie', account.cookie),
        await authed(request(failing.app).patch(path), account).send({
          name: 'X',
          expectedUpdatedAt: new Date().toISOString(),
        }),
        await authed(request(failing.app).post(`${path}/archive`), account),
        await authed(request(failing.app).post(`${path}/restore`), account),
        await authed(request(failing.app).delete(path), account),
      ];

      for (const res of responses) {
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
      }
    });
  });
});
